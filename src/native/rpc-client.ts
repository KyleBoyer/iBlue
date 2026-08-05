import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import type {
  JsonRpcFailure,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccess,
} from "../types.js";
import { NativeProfileLease } from "./profile-lease.js";

export class NativeRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "NativeRpcError";
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface NativeRpcClientOptions {
  stateDir: string;
  binaryPath?: string;
  requestTimeoutMs?: number;
  credentialKeyFile?: string;
  nacBinaryFile?: string | undefined;
  environment?: NodeJS.ProcessEnv;
}

export class NativeRpcClient extends EventEmitter {
  readonly stateDir: string;
  readonly binaryPath: string;
  readonly requestTimeoutMs: number;
  readonly credentialKeyFile: string | undefined;
  readonly nacBinaryFile: string | undefined;
  readonly environment: NodeJS.ProcessEnv;

  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #ready: Promise<void> | undefined;
  #lease: NativeProfileLease | undefined;

  constructor(options: NativeRpcClientOptions) {
    super();
    this.stateDir = resolve(options.stateDir);
    this.binaryPath = resolve(
      options.binaryPath ??
        process.env.IBLUE_NATIVE_PATH ??
        resolve(
          process.cwd(),
          `pkg/rustpushgo/target/release/iblue-native${process.platform === "win32" ? ".exe" : ""}`,
        ),
    );
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.credentialKeyFile = options.credentialKeyFile ?? process.env.IBLUE_CREDENTIAL_KEY_FILE;
    this.nacBinaryFile = options.nacBinaryFile ?? process.env.IBLUE_NAC_BINARY_FILE;
    this.environment = options.environment ?? {};
  }

  get running(): boolean {
    return this.#child !== undefined && this.#child.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = this.#start();
    try {
      await this.#ready;
    } catch (error) {
      this.#ready = undefined;
      this.#child?.kill("SIGTERM");
      this.#child = undefined;
      this.#releaseLease();
      throw error;
    }
  }

  async #start(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    this.#lease = NativeProfileLease.acquire(this.stateDir);
    await access(this.binaryPath);

    // Test harnesses and embedders may provide a Node JSON-RPC shim. Launching
    // it through the current Node executable makes that supported path portable
    // to Windows, where a shebang-marked `.mjs` file is not directly executable.
    // Production native binaries continue to be spawned directly.
    const nodeScript = /\.(?:[cm]?js|mts|cts)$/i.test(this.binaryPath);
    const command = nodeScript ? process.execPath : this.binaryPath;
    const args = [...(nodeScript ? [this.binaryPath] : []), "--state-dir", this.stateDir];
    const child = spawn(command, args, {
      cwd: this.stateDir,
      // Keep terminal Ctrl-C on the TypeScript supervisor. The supervisor can
      // then snapshot and send system.shutdown before closing the child. The
      // stdin pipe still closes if the parent dies, so the native read loop
      // exits instead of becoming an orphan.
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ...this.environment,
        // The shared rustpush wrapper normally retries NoValidTargets with a
        // forced refresh, then invokes the send path again. During an IDS
        // throttle that turns one user action into as many as three directory
        // requests. iBlue owns cooldown/retry policy at the TypeScript layer,
        // so its native child must fail the first empty send attempt instead.
        IBLUE_NO_VALID_TARGET_RETRY: "1",
        // rustpush's directory cache wrapper retries a failed id-query once.
        // iBlue owns that policy too, and the guarded canary must be exactly
        // one Apple lookup on success, error, timeout, or panic.
        IBLUE_IDS_NO_LOOKUP_RETRY: "1",
        IBLUE_DATA_DIR: this.stateDir,
        ...(this.credentialKeyFile ? { IBLUE_CREDENTIAL_KEY_FILE: resolve(this.credentialKeyFile) } : {}),
        ...(this.nacBinaryFile ? { IBLUE_NAC_BINARY_FILE: resolve(this.nacBinaryFile) } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    // A child that exits between `running` and stdin.write can emit EPIPE on
    // the stream asynchronously. Always consume it and reject outstanding RPCs
    // instead of crashing Node with an unhandled `error` event.
    child.stdin.on("error", (error) => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
    });

    const ready = new Promise<void>((resolveReady, rejectReady) => {
      const onReady = (): void => {
        cleanup();
        resolveReady();
      };
      const onError = (error: Error): void => {
        cleanup();
        rejectReady(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        rejectReady(
          new Error(`iBlue native engine exited before ready (code=${String(code)}, signal=${String(signal)})`),
        );
      };
      const cleanup = (): void => {
        this.off("engine.ready", onReady);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      this.once("engine.ready", onReady);
      child.once("error", onError);
      child.once("exit", onExit);
    });

    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on("line", (line) => this.#handleLine(line));

    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on("line", (line) => this.emit("engine.log", { level: "native", message: line }));

    child.on("exit", (code, signal) => {
      const error = new Error(
        `iBlue native engine exited (code=${String(code)}, signal=${String(signal)})`,
      );
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      this.#child = undefined;
      this.#ready = undefined;
      this.#releaseLease();
      this.emit("engine.exit", { code, signal });
    });

    await ready;
  }

  #handleLine(line: string): void {
    let payload: JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification;
    try {
      payload = JSON.parse(line) as JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification;
    } catch (error) {
      this.emit("protocol.error", new Error(`invalid native JSON: ${String(error)}`));
      return;
    }

    if (!("id" in payload)) {
      this.emit(payload.method, payload.params);
      this.emit("notification", payload);
      return;
    }

    if (typeof payload.id !== "number") return;
    const pending = this.#pending.get(payload.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(payload.id);

    if ("error" in payload) {
      pending.reject(new NativeRpcError(payload.error.message, payload.error.code, payload.error.data));
    } else {
      pending.resolve(payload.result);
    }
  }

  async request<T>(method: string, params: unknown = {}): Promise<T> {
    await this.start();
    const child = this.#child;
    if (!child || !this.running) throw new Error("iBlue native engine is not running");

    const id = this.#nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const result = new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectRequest(new Error(`native request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.#pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        timer,
      });
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
    return result;
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (!child || !this.running) {
      this.#releaseLease();
      return;
    }
    try {
      await this.request("system.shutdown");
    } catch {
      child.kill("SIGTERM");
    }
    if (child.exitCode !== null) return;
    if (await waitForChildExit(child, 5_000)) return;
    child.kill("SIGTERM");
    if (await waitForChildExit(child, 5_000)) return;
    throw new Error(
      `iBlue native engine did not exit after shutdown; profile lease remains held (${this.stateDir})`,
    );
  }

  #releaseLease(): void {
    const lease = this.#lease;
    this.#lease = undefined;
    if (lease) {
      try {
        lease.release();
      } catch (error) {
        this.emit("protocol.error", error);
      }
    }
  }
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolveExit(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

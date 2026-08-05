import type { IncomingMessage } from "./types.js";

export type IdsCanaryReceiptEvidence =
  | { kind: "delivered"; timestampMs: number }
  | { kind: "read"; timestampMs: number }
  | {
      kind: "error";
      timestampMs: number;
      status?: number;
      message?: string;
    }
  | { kind: "timeout" };

export interface IdsCanaryReceiptSource {
  on(event: "message.received", listener: (message: IncomingMessage) => void): unknown;
  off(event: "message.received", listener: (message: IncomingMessage) => void): unknown;
}

interface PendingReceipt {
  guid: string;
  resolve: (evidence: IdsCanaryReceiptEvidence) => void;
  timer: NodeJS.Timeout;
}

/**
 * Observe before sending so a receipt delivered before message.send returns is
 * not lost. Only control messages are buffered, and the buffer is deliberately
 * bounded because an IDS client can also receive unrelated account traffic.
 */
export class IdsCanaryReceiptMonitor {
  readonly #source: IdsCanaryReceiptSource;
  readonly #buffer: IncomingMessage[] = [];
  #pending: PendingReceipt | undefined;
  #closed = false;

  constructor(source: IdsCanaryReceiptSource) {
    this.#source = source;
    this.#source.on("message.received", this.#handleMessage);
  }

  waitFor(guid: string, timeoutMs: number): Promise<IdsCanaryReceiptEvidence> {
    if (this.#closed) throw new Error("IDS canary receipt monitor is closed");
    if (this.#pending) throw new Error("IDS canary receipt monitor already has a pending wait");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("IDS canary receipt timeout must be a non-negative finite number");
    }

    const bufferedIndex = this.#buffer.findIndex(
      (message) => evidenceForCanaryMessage(message, guid) !== undefined,
    );
    if (bufferedIndex >= 0) {
      const [message] = this.#buffer.splice(bufferedIndex, 1);
      return Promise.resolve(evidenceForCanaryMessage(message!, guid)!);
    }
    if (timeoutMs === 0) return Promise.resolve({ kind: "timeout" });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending = undefined;
        resolve({ kind: "timeout" });
      }, timeoutMs);
      this.#pending = { guid, resolve, timer };
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#source.off("message.received", this.#handleMessage);
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve({ kind: "timeout" });
    }
    this.#buffer.length = 0;
  }

  readonly #handleMessage = (message: IncomingMessage): void => {
    const pending = this.#pending;
    if (pending) {
      const evidence = evidenceForCanaryMessage(message, pending.guid);
      if (evidence) {
        clearTimeout(pending.timer);
        this.#pending = undefined;
        pending.resolve(evidence);
        return;
      }
    }

    if (!message.delivered && !message.readReceipt && !message.error) return;
    this.#buffer.push(message);
    if (this.#buffer.length > 128) this.#buffer.shift();
  };
}

export function evidenceForCanaryMessage(
  message: IncomingMessage,
  guid: string,
): Exclude<IdsCanaryReceiptEvidence, { kind: "timeout" }> | undefined {
  const expected = guid.toLowerCase();
  if (message.error) {
    const target = message.error.forUuid ?? message.uuid;
    if (target.toLowerCase() !== expected) return undefined;
    return {
      kind: "error",
      timestampMs: message.timestampMs || Date.now(),
      ...(message.error.status === undefined ? {} : { status: message.error.status }),
      ...(message.error.message === undefined ? {} : { message: message.error.message }),
    };
  }
  if (message.uuid.toLowerCase() !== expected) return undefined;
  if (message.readReceipt) {
    return { kind: "read", timestampMs: message.timestampMs || Date.now() };
  }
  if (message.delivered) {
    return { kind: "delivered", timestampMs: message.timestampMs || Date.now() };
  }
  return undefined;
}

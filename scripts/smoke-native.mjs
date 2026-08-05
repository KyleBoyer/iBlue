import { parseArgs } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const { values } = parseArgs({
  options: {
    binary: { type: "string" },
    platform: { type: "string" },
    architecture: { type: "string" },
    "expect-registration-unavailable": { type: "boolean", default: false },
  },
  strict: true,
});

const hostPlatform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform;
const hostArchitecture = process.arch === "x64"
  ? "x86_64"
  : process.arch === "arm64"
    ? "aarch64"
    : process.arch;
const binary = resolve(
  values.binary ??
    join(
      process.cwd(),
      "pkg",
      "rustpushgo",
      "target",
      "release",
      `iblue-native${process.platform === "win32" ? ".exe" : ""}`,
    ),
);
const expectedPlatform = values.platform ?? hostPlatform;
const expectedArchitecture = values.architecture ?? hostArchitecture;
const stateDir = mkdtempSync(join(tmpdir(), "iblue-native-smoke-"));
const environment = {
  ...process.env,
  IBLUE_DATA_DIR: stateDir,
  IBLUE_OFFLINE_ONLY: "1",
};

// The smoke check must prove the binary starts without any operator secret or
// Apple network access. In particular, do not accidentally inherit a live NAC
// binary, hardware identity, or credential key from the invoking shell.
delete environment.IBLUE_NAC_BINARY_FILE;
delete environment.IBLUE_HARDWARE_KEY_FILE;
delete environment.IBLUE_CREDENTIAL_KEY_FILE;

try {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "system.version", params: {} },
    { jsonrpc: "2.0", id: 2, method: "system.shutdown", params: {} },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n";
  const result = spawnSync(binary, ["--state-dir", stateDir], {
    encoding: "utf8",
    env: environment,
    input,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    timeout: 30_000,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `native engine exited with ${String(result.status)}\n${result.stderr.trim()}`,
    );
  }

  const messages = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const response = messages.find((message) => message.id === 1);
  if (!response?.result) throw new Error("system.version response was not returned");

  const version = response.result;
  if (version.platform !== expectedPlatform) {
    throw new Error(`expected platform ${expectedPlatform}, got ${String(version.platform)}`);
  }
  if (version.architecture !== expectedArchitecture) {
    throw new Error(
      `expected architecture ${expectedArchitecture}, got ${String(version.architecture)}`,
    );
  }
  if (expectedPlatform !== "macos") {
    if (version.registrationBackend !== "unicorn-imdappleservices-external") {
      throw new Error(`unexpected portable registration backend: ${String(version.registrationBackend)}`);
    }
    if (version.hardwareKeyRequired !== true) {
      throw new Error(`${expectedPlatform} must require an extracted hardware key`);
    }
  }
  if (values["expect-registration-unavailable"] && version.registrationAvailable !== false) {
    throw new Error("registration must remain unavailable without the external Apple binary");
  }
  if (!messages.some((message) => message.id === 2 && message.result?.stopped === true)) {
    throw new Error("system.shutdown response was not returned");
  }

  const credentialServicePath = join(stateDir, "credential-service");
  if (!existsSync(credentialServicePath)) {
    throw new Error("native engine did not persist its portable credential service identity");
  }
  const credentialService = readFileSync(credentialServicePath, "utf8").trim();
  if (!/^app\.iblue\.ids\.[a-f0-9]{64}$/u.test(credentialService)) {
    throw new Error("native engine persisted an invalid credential service identity");
  }
  if (process.platform !== "win32" && (statSync(credentialServicePath).mode & 0o777) !== 0o600) {
    throw new Error("credential service identity must be owner-readable only");
  }

  process.stdout.write(`${JSON.stringify(version, null, 2)}\n`);
} finally {
  rmSync(stateDir, { force: true, recursive: true });
}

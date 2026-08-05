import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("registration-inspect uses only the offline RPC and does not initialize Apple transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "iblue-registration-inspect-test-"));
  const dataRoot = join(root, "data");
  const profileRoot = join(dataRoot, "profiles", "secondary");
  const executable = join(root, "mock-native.mjs");
  const calls = join(root, "calls.ndjson");
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(profileRoot, "session.json"),
    JSON.stringify({
      version: 1,
      profile: "secondary",
      users: "opaque-saved-users",
      handles: ["mailto:secondary@example.com"],
      updatedAt: new Date(0).toISOString(),
    }),
    { mode: 0o600 },
  );
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"engine.ready",params:{protocolVersion:"1"}})+"\\n");
createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  appendFileSync(process.env.IBLUE_TEST_CALLS, JSON.stringify({
    method: request.method,
    params: request.params,
    offlineOnly: process.env.IBLUE_OFFLINE_ONLY,
  })+"\\n");
  const result = request.method === "account.registration.inspect"
    ? {
        mode:"offline",
        appleNetworkAccessed:false,
        accountCredentialAccessed:false,
        softwareKeystoreRead:true,
        savedStateSha256:"ab".repeat(32),
        userCount:1,
        sendingHandles:["mailto:secondary@example.com"],
        requiredServices:["com.apple.madrid"],
        completeServiceBundle:true,
        allKeyMaterialAvailable:true,
        locallyUsableForMadrid:true,
        users:[],
        warnings:[],
      }
    : {stopped:true};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
  if (request.method === "system.shutdown") process.exit(0);
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);

  const result = await runCli([
    "registration-inspect",
    "--profile",
    "secondary",
    "--data-root",
    dataRoot,
    "--native",
    executable,
    "--json",
  ], { IBLUE_TEST_CALLS: calls });

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout) as {
    profile: string;
    inspection: { mode: string; appleNetworkAccessed: boolean; locallyUsableForMadrid: boolean };
  };
  assert.deepEqual(output, {
    profile: "secondary",
    inspection: {
      mode: "offline",
      appleNetworkAccessed: false,
      accountCredentialAccessed: false,
      softwareKeystoreRead: true,
      savedStateSha256: "ab".repeat(32),
      userCount: 1,
      sendingHandles: ["mailto:secondary@example.com"],
      requiredServices: ["com.apple.madrid"],
      completeServiceBundle: true,
      allKeyMaterialAvailable: true,
      locallyUsableForMadrid: true,
      users: [],
      warnings: [],
    },
  });
  const recorded = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; params: unknown; offlineOnly: string });
  assert.deepEqual(recorded.map(({ method }) => method), [
    "account.registration.inspect",
    "system.shutdown",
  ]);
  assert.deepEqual(recorded[0], {
    method: "account.registration.inspect",
    params: { users: "opaque-saved-users" },
    offlineOnly: "1",
  });
  assert.equal(recorded.some(({ method }) => method === "system.initialize"), false);
});

test("registration-inspect fails locally when no saved IDS registration exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "iblue-registration-inspect-empty-test-"));
  const profileRoot = join(root, "data", "profiles", "secondary");
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(profileRoot, "session.json"),
    JSON.stringify({
      version: 1,
      profile: "secondary",
      handles: [],
      updatedAt: new Date(0).toISOString(),
    }),
    { mode: 0o600 },
  );

  const result = await runCli([
    "registration-inspect",
    "--profile",
    "secondary",
    "--data-root",
    join(root, "data"),
  ], {});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /has no saved IDS registration/);
});

function runCli(args: string[], environment: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), ...args],
      {
        cwd: resolve("."),
        env: { ...process.env, ...environment },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
  });
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("local-only logout skips initialization and removes the saved session", async () => {
  const root = await mkdtemp(join(tmpdir(), "iblue-logout-test-"));
  const dataRoot = join(root, "data");
  const profileRoot = join(dataRoot, "profiles", "secondary");
  const executable = join(root, "mock-native.mjs");
  const calls = join(root, "calls.txt");

  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(profileRoot, "session.json"),
    JSON.stringify({
      version: 1,
      profile: "secondary",
      deviceId: "test-device",
      apsState: {},
      handles: [],
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
  appendFileSync(process.env.IBLUE_TEST_CALLS, request.method+"\\n");
  const result = request.method === "account.logout"
    ? {deregistered:false,credentialDeleted:true}
    : {stopped:true};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
  if (request.method === "system.shutdown") process.exit(0);
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);

  const result = await runCli([
    "logout",
    "--profile",
    "secondary",
    "--data-root",
    dataRoot,
    "--native",
    executable,
    "--local-only",
  ], { IBLUE_TEST_CALLS: calls });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /local credentials and login session were removed/);
  assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), [
    "account.logout",
    "system.shutdown",
  ]);
  await assert.rejects(readFile(join(profileRoot, "session.json")), { code: "ENOENT" });
});

test("remote logout initializes saved transport state without checking NAC availability", async () => {
  const root = await mkdtemp(join(tmpdir(), "iblue-remote-logout-test-"));
  const dataRoot = join(root, "data");
  const profileRoot = join(dataRoot, "profiles", "secondary");
  const executable = join(root, "mock-native.mjs");
  const calls = join(root, "calls.txt");

  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(profileRoot, "session.json"),
    JSON.stringify({
      version: 1,
      profile: "secondary",
      deviceId: "test-device",
      apsState: {},
      users: "saved-users",
      identity: "saved-identity",
      accountUsername: "name@example.com",
      handles: ["mailto:name@example.com"],
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
  appendFileSync(process.env.IBLUE_TEST_CALLS, request.method+"\\n");
  const result = request.method === "account.logout"
    ? {deregistered:true,credentialDeleted:true}
    : request.method === "system.initialize"
      ? {protocolVersion:"1",deviceId:"test-device",apsState:"{}",handles:[]}
      : {stopped:true};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
  if (request.method === "system.shutdown") process.exit(0);
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);

  const result = await runCli([
    "logout",
    "--profile",
    "secondary",
    "--data-root",
    dataRoot,
    "--native",
    executable,
  ], { IBLUE_TEST_CALLS: calls });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /was deregistered from Apple IDS/);
  assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), [
    "system.initialize",
    "account.logout",
    "system.shutdown",
  ]);
  assert.doesNotMatch(await readFile(calls, "utf8"), /system\.version/);
  await assert.rejects(readFile(join(profileRoot, "session.json")), { code: "ENOENT" });
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

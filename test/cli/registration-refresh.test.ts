import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const savedSession = {
  version: 1,
  profile: "secondary",
  deviceId: "stable-device-id",
  apsState: "opaque-apns-state",
  users: "pre-refresh-users",
  identity: "stable-ngm-identity",
  accountUsername: "secondary@example.com",
  handles: ["mailto:secondary@example.com"],
  updatedAt: new Date(0).toISOString(),
};

test("registration-refresh reuses the saved identity and starts a new quiet period", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-registration-refresh-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const profileRoot = join(dataRoot, "profiles", "secondary");
  const executable = join(root, "mock-native.mjs");
  const callsPath = join(root, "calls.ndjson");
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(profileRoot, "session.json"), `${JSON.stringify(savedSession)}\n`, { mode: 0o600 });
  await writeFile(join(profileRoot, "ids-policy.json"), `${JSON.stringify({
    version: 1,
    enabledAt: "2000-01-01T00:00:00.000Z",
    passiveUntil: "2000-01-04T00:00:00.000Z",
    reason: "expired failed-canary cooldown",
  })}\n`, { mode: 0o600 });
  const priorCanary = {
    version: 1,
    id: "empty-canary",
    profile: "secondary",
    state: "lookup-no-send",
    target: "mailto:friend@example.com",
    sender: "mailto:secondary@example.com",
    messageSha256: "ab".repeat(32),
    startedAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:01.000Z",
    completedAt: "2000-01-01T00:00:01.000Z",
  };
  await writeFile(
    join(profileRoot, "ids-canary.json"),
    `${JSON.stringify(priorCanary)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const initialized = {
  protocolVersion:"1",
  deviceId:"stable-device-id",
  apsState:"updated-apns-state",
  users:"pre-refresh-users",
  identity:"stable-ngm-identity",
  accountUsername:"secondary@example.com",
  credentialBackend:"encrypted-file",
  idsMode:"passive",
  handles:["mailto:secondary@example.com"],
  clientStarted:false,
  secondsSinceLastInbound:0,
};
const refreshed = {...initialized, users:"refreshed-users"};
process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"engine.ready",params:{protocolVersion:"1"}})+"\\n");
createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  appendFileSync(process.env.IBLUE_TEST_CALLS, JSON.stringify({
    method:request.method,
    params:request.params,
    passive:process.env.IBLUE_IDS_PASSIVE,
  })+"\\n");
  const result = request.method === "account.registration.refresh"
    ? {registeredServices:4, snapshot:refreshed}
    : request.method === "system.shutdown"
      ? {stopped:true}
      : initialized;
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
  if (request.method === "system.shutdown") process.exit(0);
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);

  const result = await runCli([
    "registration-refresh",
    "--profile",
    "secondary",
    "--data-root",
    dataRoot,
    "--native",
    executable,
    "--confirm",
  ], { IBLUE_TEST_CALLS: callsPath });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /refreshed 4 IDS service registrations/);
  assert.match(result.stdout, /existing device ID, APNs identity, and NGM keys/);
  assert.match(result.stdout, /no Apple password, 2FA, VM, or Messages\.app sign-in was used/);
  assert.match(result.stdout, /Prior canary evidence was archived/);

  const calls = (await readFile(callsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; params: unknown; passive: string });
  assert.deepEqual(calls.map(({ method }) => method), [
    "system.initialize",
    "account.registration.refresh",
    "system.shutdown",
  ]);
  assert.ok(calls.every(({ passive }) => passive === "1"));
  assert.equal(calls.some(({ method }) => /handle|message|login/.test(method)), false);

  const session = JSON.parse(await readFile(join(profileRoot, "session.json"), "utf8")) as {
    deviceId: string;
    identity: string;
    users: string;
  };
  assert.equal(session.deviceId, savedSession.deviceId);
  assert.equal(session.identity, savedSession.identity);
  assert.equal(session.users, "refreshed-users");

  const policy = JSON.parse(await readFile(join(profileRoot, "ids-policy.json"), "utf8")) as {
    enabledAt: string;
    passiveUntil: string;
    reason: string;
  };
  assert.equal(Date.parse(policy.passiveUntil) - Date.parse(policy.enabledAt), 72 * 60 * 60 * 1_000);
  assert.match(policy.reason, /registration refresh/);
  await assert.rejects(readFile(join(profileRoot, "ids-canary.json")), { code: "ENOENT" });
  assert.deepEqual(
    JSON.parse(await readFile(
      join(profileRoot, "ids-canary.json.empty-canary.before-refresh.json"),
      "utf8",
    )),
    priorCanary,
  );
});

test("registration-refresh refuses active cooldowns and missing confirmation before native launch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-registration-refresh-guard-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const profileRoot = join(dataRoot, "profiles", "secondary");
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(profileRoot, "session.json"), `${JSON.stringify(savedSession)}\n`, { mode: 0o600 });
  const impossibleNative = join(root, "must-not-launch.exe");

  await writeFile(join(profileRoot, "ids-policy.json"), `${JSON.stringify({
    version: 1,
    enabledAt: "2099-01-01T00:00:00.000Z",
    passiveUntil: "2099-01-04T00:00:00.000Z",
    reason: "active test cooldown",
  })}\n`, { mode: 0o600 });
  const active = await runCli([
    "registration-refresh",
    "--profile",
    "secondary",
    "--data-root",
    dataRoot,
    "--native",
    impossibleNative,
    "--confirm",
  ], {});
  assert.equal(active.code, 1);
  assert.match(active.stderr, /cannot bypass the quiet period/);
  assert.doesNotMatch(active.stderr, /ENOENT|must-not-launch/);

  await writeFile(join(profileRoot, "ids-policy.json"), `${JSON.stringify({
    version: 1,
    enabledAt: "2000-01-01T00:00:00.000Z",
    passiveUntil: "2000-01-04T00:00:00.000Z",
    reason: "expired test cooldown",
  })}\n`, { mode: 0o600 });
  const unconfirmed = await runCli([
    "registration-refresh",
    "--profile",
    "secondary",
    "--data-root",
    dataRoot,
    "--native",
    impossibleNative,
  ], {});
  assert.equal(unconfirmed.code, 1);
  assert.match(unconfirmed.stderr, /rerun with --confirm/);
  assert.doesNotMatch(unconfirmed.stderr, /ENOENT|must-not-launch/);

  await writeFile(join(profileRoot, "ids-canary.json"), `${JSON.stringify({
    version: 1,
    id: "accepted-canary",
    profile: "secondary",
    state: "transport-accepted",
    target: "mailto:friend@example.com",
    sender: "mailto:secondary@example.com",
    messageSha256: "ab".repeat(32),
    startedAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:01.000Z",
  })}\n`, { mode: 0o600 });
  const wrongRecovery = await runCli([
    "registration-refresh",
    "--profile",
    "secondary",
    "--data-root",
    dataRoot,
    "--native",
    impossibleNative,
    "--confirm",
  ], {});
  assert.equal(wrongRecovery.code, 1);
  assert.match(wrongRecovery.stderr, /only valid after a canary lookup that sent no message/);
  assert.doesNotMatch(wrongRecovery.stderr, /ENOENT|must-not-launch/);
  await rm(join(profileRoot, "ids-canary.json"));

  await rm(join(profileRoot, "ids-policy.json"));
  const noCooldownRecord = await runCli([
    "registration-refresh",
    "--profile",
    "secondary",
    "--data-root",
    dataRoot,
    "--native",
    impossibleNative,
    "--confirm",
  ], {});
  assert.equal(noCooldownRecord.code, 1);
  assert.match(noCooldownRecord.stderr, /requires a completed IDS cooldown record/);
  assert.doesNotMatch(noCooldownRecord.stderr, /ENOENT|must-not-launch/);
});

test("a failed registration refresh still enforces the new quiet period", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-registration-refresh-failure-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const profileRoot = join(dataRoot, "profiles", "secondary");
  const executable = join(root, "mock-native.mjs");
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(profileRoot, "session.json"), `${JSON.stringify(savedSession)}\n`, { mode: 0o600 });
  await writeFile(join(profileRoot, "ids-policy.json"), `${JSON.stringify({
    version: 1,
    enabledAt: "2000-01-01T00:00:00.000Z",
    passiveUntil: "2000-01-04T00:00:00.000Z",
    reason: "expired failed-canary cooldown",
  })}\n`, { mode: 0o600 });
  await writeFile(join(profileRoot, "ids-canary.json"), `${JSON.stringify({
    version: 1,
    id: "interrupted-canary",
    profile: "secondary",
    state: "in-progress",
    target: "mailto:friend@example.com",
    sender: "mailto:secondary@example.com",
    messageSha256: "cd".repeat(32),
    startedAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
const snapshot = {
  protocolVersion:"1", deviceId:"stable-device-id", apsState:"updated-apns-state",
  users:"pre-refresh-users", identity:"stable-ngm-identity",
  accountUsername:"secondary@example.com", credentialBackend:"encrypted-file",
  idsMode:"passive", handles:["mailto:secondary@example.com"],
  clientStarted:false, secondsSinceLastInbound:0,
};
process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"engine.ready",params:{protocolVersion:"1"}})+"\\n");
createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  const payload = request.method === "account.registration.refresh"
    ? {jsonrpc:"2.0",id:request.id,error:{code:-32000,message:"simulated Apple registration failure"}}
    : {jsonrpc:"2.0",id:request.id,result:request.method === "system.shutdown" ? {stopped:true} : snapshot};
  process.stdout.write(JSON.stringify(payload)+"\\n");
  if (request.method === "system.shutdown") process.exit(0);
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);

  const before = Date.now();
  const result = await runCli([
    "registration-refresh",
    "--profile",
    "secondary",
    "--data-root",
    dataRoot,
    "--native",
    executable,
    "--confirm",
  ], {});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /simulated Apple registration failure/);
  const policy = JSON.parse(await readFile(join(profileRoot, "ids-policy.json"), "utf8")) as {
    enabledAt: string;
    passiveUntil: string;
    reason: string;
  };
  assert.ok(Date.parse(policy.enabledAt) >= before);
  assert.equal(Date.parse(policy.passiveUntil) - Date.parse(policy.enabledAt), 72 * 60 * 60 * 1_000);
  assert.match(policy.reason, /registration refresh attempted/);
  const preservedJournal = JSON.parse(await readFile(join(profileRoot, "ids-canary.json"), "utf8")) as {
    state: string;
  };
  assert.equal(preservedJournal.state, "in-progress");

  const interruptedStatus = await runCli([
    "ids-canary-status",
    "--profile",
    "secondary",
    "--data-root",
    dataRoot,
  ], {});
  assert.equal(interruptedStatus.code, 0, interruptedStatus.stderr);
  assert.match(interruptedStatus.stdout, /interrupted attempt has an unknown outcome/);
  assert.match(interruptedStatus.stdout, /Do not repeat it/);
});

function runCli(args: string[], environment: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), ...args], {
      cwd: resolve("."),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
  });
}

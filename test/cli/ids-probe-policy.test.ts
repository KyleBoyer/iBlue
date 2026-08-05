import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { BlueBubblesStore } from "../../src/bluebubbles/store.js";
import { NativeProfileLease } from "../../src/native/profile-lease.js";

test("an empty CLI probe performs one APNs lookup and persists a 72-hour cooldown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-ids-probe-policy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const profileRoot = join(dataRoot, "profiles", "secondary");
  const executable = join(root, "mock-native.mjs");
  const callsPath = join(root, "calls.ndjson");
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(profileRoot, "session.json"),
    `${JSON.stringify({
      version: 1,
      profile: "secondary",
      deviceId: "device-id",
      apsState: "opaque-apns-state",
      users: "opaque-users",
      identity: "opaque-identity",
      accountUsername: "secondary@example.com",
      handles: ["mailto:secondary@example.com"],
      updatedAt: new Date(0).toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
const snapshot = {
  protocolVersion:"1",
  deviceId:"device-id",
  apsState:"opaque-apns-state",
  users:"opaque-users",
  identity:"opaque-identity",
  accountUsername:"secondary@example.com",
  credentialBackend:"encrypted-file",
  idsMode:"normal",
  handles:["mailto:secondary@example.com"],
  clientStarted:true,
  secondsSinceLastInbound:0,
};
process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"engine.ready",params:{protocolVersion:"1"}})+"\\n");
createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  appendFileSync(process.env.IBLUE_TEST_CALLS, JSON.stringify({
    method:request.method,
    params:request.params,
    canaryJournalExists:existsSync(resolve(process.env.IBLUE_DATA_DIR, "..", "ids-canary.json")),
    canaryPolicyExists:existsSync(resolve(process.env.IBLUE_DATA_DIR, "..", "ids-policy.json")),
  })+"\\n");
  let result;
  if (request.method === "system.initialize" || request.method === "client.start" || request.method === "system.snapshot") result = snapshot;
  else if (request.method === "handle.validate") result = {available:[]};
  else if (request.method === "handle.lookup") result = {
    available:[],
    targets:request.params.addresses.map(address => ({
      address,
      cacheEntryFresh:true,
      responseEntryReturned:true,
      identityCount:0,
      correlationIdentifierPresent:false,
    })),
    error:null,
    panicked:false,
    timedOut:false,
    attempts:1,
  };
  else if (request.method === "message.send") result = {guid:"must-not-send"};
  else if (request.method === "system.shutdown") result = {stopped:true};
  else result = {available:["unexpected"]};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
  if (request.method === "system.shutdown") process.exit(0);
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);

  const result = await runCli([
    "ids-probe",
    "--profile",
    "secondary",
    "--data-root",
    dataRoot,
    "--native",
    executable,
    "--transport",
    "apns",
    "+16515550100",
  ], { IBLUE_TEST_CALLS: callsPath });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /tel:\+16515550100\tAPNS_TUNNEL\tempty/);
  assert.match(result.stdout, /passive IDS cooldown extended/);
  assert.match(result.stdout, /Do not try another target or transport/);

  const calls = (await readFile(callsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as {
      method: string;
      params: unknown;
      canaryJournalExists: boolean;
      canaryPolicyExists: boolean;
    });
  assert.deepEqual(calls.map(({ method }) => method), [
    "system.initialize",
    "client.start",
    "handle.validate",
    "system.shutdown",
  ]);
  assert.deepEqual(calls[2]!.params, { addresses: ["tel:+16515550100"] });

  const policyPath = join(profileRoot, "ids-policy.json");
  const policy = JSON.parse(await readFile(policyPath, "utf8")) as {
    enabledAt: string;
    passiveUntil: string;
    reason: string;
  };
  assert.equal(Date.parse(policy.passiveUntil) - Date.parse(policy.enabledAt), 72 * 60 * 60 * 1_000);
  assert.equal(policy.reason.includes("+16515550100"), false);
  if (process.platform !== "win32") assert.equal((await stat(policyPath)).mode & 0o777, 0o600);

  // Expire the first backoff locally, then prove the guarded canary performs
  // one two-address preflight and never invokes message.send on an empty
  // result. No --force escape hatch exists for an active canary cooldown.
  await writeFile(policyPath, `${JSON.stringify({
    version: 1,
    enabledAt: "2000-01-01T00:00:00.000Z",
    passiveUntil: "2000-01-04T00:00:00.000Z",
    reason: "expired test policy",
  })}\n`, { mode: 0o600 });
  const canary = await runCli([
    "ids-canary",
    "--profile",
    "secondary",
    "--data-root",
    dataRoot,
    "--native",
    executable,
    "--message",
    "must not send",
    "+16515550100",
  ], { IBLUE_TEST_CALLS: callsPath });
  assert.equal(canary.code, 0, canary.stderr);
  assert.match(canary.stdout, /RECIPIENT\ttel:\+16515550100\texplicit-empty/);
  assert.match(canary.stdout, /native lookup retries and panic bisection disabled/);
  assert.match(canary.stdout, /No message send was attempted/);

  const allCalls = (await readFile(callsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as {
      method: string;
      params: unknown;
      canaryJournalExists: boolean;
      canaryPolicyExists: boolean;
    });
  const canaryCalls = allCalls.slice(calls.length);
  assert.deepEqual(canaryCalls.map(({ method }) => method), [
    "system.initialize",
    "client.start",
    "handle.lookup",
    "system.snapshot",
    "system.shutdown",
  ]);
  assert.deepEqual(canaryCalls[2]!.params, {
    addresses: ["tel:+16515550100", "mailto:secondary@example.com"],
    from: "mailto:secondary@example.com",
  });
  assert.equal(canaryCalls[2]!.canaryJournalExists, true);
  assert.equal(canaryCalls[2]!.canaryPolicyExists, true);
  assert.equal(allCalls.some(({ method }) => method === "message.send"), false);
});

test("an active cooldown rejects a probe before launching the native process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-ids-probe-guard-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profileRoot = join(root, "data", "profiles", "secondary");
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(profileRoot, "ids-policy.json"),
    `${JSON.stringify({
      version: 1,
      enabledAt: "2099-01-01T00:00:00.000Z",
      passiveUntil: "2099-01-04T00:00:00.000Z",
      reason: "test guard",
    })}\n`,
    { mode: 0o600 },
  );

  const result = await runCli([
    "ids-probe",
    "--profile",
    "secondary",
    "--data-root",
    join(root, "data"),
    "--native",
    join(root, "must-not-launch.exe"),
    "+16515550100",
  ], {});

  assert.equal(result.code, 1);
  assert.match(result.stderr, /IDS cooldown is active until 2099-01-04/);
  assert.doesNotMatch(result.stderr, /ENOENT|must-not-launch/);

  const canary = await runCli([
    "ids-canary",
    "--profile",
    "secondary",
    "--data-root",
    join(root, "data"),
    "--native",
    join(root, "must-not-launch.exe"),
    "--message",
    "blocked",
    "+16515550100",
  ], {});
  assert.equal(canary.code, 1);
  assert.match(canary.stderr, /ids-canary cannot bypass an active cooldown/);
  assert.doesNotMatch(canary.stderr, /ENOENT|must-not-launch/);

  const humanStatus = await runCli([
    "ids-canary-status",
    "--profile",
    "secondary",
    "--data-root",
    join(root, "data"),
  ], {});
  assert.equal(humanStatus.code, 0, humanStatus.stderr);
  assert.match(humanStatus.stdout, /No IDS canary journal exists/);
  assert.match(humanStatus.stdout, /cooldown: active until 2099-01-04T00:00:00.000Z/);

  const jsonStatus = await runCli([
    "ids-canary-status",
    "--profile",
    "secondary",
    "--data-root",
    join(root, "data"),
    "--json",
  ], {});
  assert.equal(jsonStatus.code, 0, jsonStatus.stderr);
  const parsedStatus = JSON.parse(jsonStatus.stdout) as {
    appleNetworkAccessed: boolean;
    journal: null;
    policy: { active: boolean; passiveUntil: string };
  };
  assert.equal(parsedStatus.appleNetworkAccessed, false);
  assert.equal(parsedStatus.journal, null);
  assert.equal(parsedStatus.policy.active, true);
  assert.equal(parsedStatus.policy.passiveUntil, "2099-01-04T00:00:00.000Z");
});

test("a held profile lease rejects the canary before creating one-shot evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-ids-canary-lease-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const profileRoot = join(dataRoot, "profiles", "secondary");
  const nativeRoot = join(profileRoot, "native");
  await mkdir(nativeRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(profileRoot, "session.json"),
    `${JSON.stringify({
      version: 1,
      profile: "secondary",
      deviceId: "device-id",
      apsState: "opaque-apns-state",
      users: "opaque-users",
      identity: "opaque-identity",
      accountUsername: "secondary@example.com",
      handles: ["mailto:secondary@example.com"],
      updatedAt: new Date(0).toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  const expiredPolicy = {
    version: 1,
    enabledAt: "2000-01-01T00:00:00.000Z",
    passiveUntil: "2000-01-04T00:00:00.000Z",
    reason: "expired test policy",
  };
  const policyPath = join(profileRoot, "ids-policy.json");
  await writeFile(policyPath, `${JSON.stringify(expiredPolicy)}\n`, { mode: 0o600 });

  const lease = NativeProfileLease.acquire(nativeRoot);
  t.after(() => lease.release());
  const result = await runCli([
    "ids-canary",
    "--profile",
    "secondary",
    "--data-root",
    dataRoot,
    "--native",
    join(root, "must-not-launch"),
    "--message",
    "must not be journaled",
    "+16515550100",
  ], {});

  assert.equal(result.code, 1);
  assert.match(result.stderr, /profile native state is already in use/);
  assert.doesNotMatch(result.stderr, /ENOENT|must-not-launch/);
  await assert.rejects(readFile(join(profileRoot, "ids-canary.json")), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), expiredPolicy);
});

test("a successful canary persists its GUID and distinguishes delivery from APNs acceptance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-ids-canary-receipt-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const profileRoot = join(dataRoot, "profiles", "secondary");
  const executable = join(root, "mock-native.mjs");
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(profileRoot, "session.json"),
    `${JSON.stringify({
      version: 1,
      profile: "secondary",
      deviceId: "device-id",
      apsState: "opaque-apns-state",
      users: "opaque-users",
      identity: "opaque-identity",
      accountUsername: "secondary@example.com",
      handles: ["mailto:secondary@example.com"],
      updatedAt: new Date(0).toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
const guid = process.env.IBLUE_TEST_GUID;
const evidence = process.env.IBLUE_TEST_EVIDENCE;
const snapshot = {
  protocolVersion:"1", deviceId:"device-id", apsState:"opaque-apns-state",
  users:"opaque-users", identity:"opaque-identity", accountUsername:"secondary@example.com",
  credentialBackend:"encrypted-file", idsMode:"passive",
  handles:["mailto:secondary@example.com"], clientStarted:true, secondsSinceLastInbound:0,
};
process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"engine.ready",params:{protocolVersion:"1"}})+"\\n");
createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  let result;
  if (request.method === "system.initialize" || request.method === "client.start" || request.method === "system.snapshot") result = snapshot;
  else if (request.method === "handle.lookup") result = {
    available:request.params.addresses,
    targets:request.params.addresses.map(address => ({
      address, cacheEntryFresh:true, responseEntryReturned:true, identityCount:1,
      correlationIdentifierPresent:true,
    })),
    error:null, panicked:false, timedOut:false, attempts:1,
  };
  else if (request.method === "message.send") {
    result = {guid};
    const control = evidence === "error"
      ? {uuid:"error-envelope",error:{forUuid:guid,status:47,message:"Not delivered"}}
      : {uuid:guid,[evidence]:true};
    process.stdout.write(JSON.stringify({
      jsonrpc:"2.0", method:"message.received", params:{
        ...control, participants:[], timestampMs:123, isSms:false,
        isStoredMessage:false, attachments:[],
      },
    })+"\\n");
  }
  else if (request.method === "system.shutdown") result = {stopped:true};
  else result = {};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
  if (request.method === "system.shutdown") process.exit(0);
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);

  const delivered = await runCli([
    "ids-canary", "--profile", "secondary", "--data-root", dataRoot,
    "--native", executable, "--receipt-wait-seconds", "1",
    "--message", "delivery canary", "friend@example.com",
  ], { IBLUE_TEST_GUID: "delivery-guid", IBLUE_TEST_EVIDENCE: "delivered" });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.match(delivered.stdout, /accepted by APNs with GUID delivery-guid/);
  assert.match(delivered.stdout, /transport acceptance, not delivery proof/);
  assert.match(delivered.stdout, /delivery confirmed by an IDS receipt/);

  let store = new BlueBubblesStore(join(profileRoot, "iblue.sqlite"), join(profileRoot, "attachments"));
  assert.equal(store.getMessage("delivery-guid")?.isDelivered, true);
  assert.equal(store.getMessage("delivery-guid")?.text, "delivery canary");
  store.close();

  const journalPath = join(profileRoot, "ids-canary.json");
  const journalText = await readFile(journalPath, "utf8");
  const journal = JSON.parse(journalText) as {
    state: string;
    messageSha256: string;
    result: { guid: string };
    receipt: { kind: string };
  };
  assert.equal(journal.state, "transport-accepted");
  assert.equal(journal.result.guid, "delivery-guid");
  assert.equal(journal.receipt.kind, "delivered");
  assert.match(journal.messageSha256, /^[a-f0-9]{64}$/);
  assert.equal(journalText.includes("delivery canary"), false);
  if (process.platform !== "win32") assert.equal((await stat(journalPath)).mode & 0o777, 0o600);

  const statusResult = await runCli([
    "ids-canary-status", "--profile", "secondary", "--data-root", dataRoot, "--json",
  ], {});
  assert.equal(statusResult.code, 0, statusResult.stderr);
  const status = JSON.parse(statusResult.stdout) as {
    appleNetworkAccessed: boolean;
    status: { outcome: string; guid: string; source: string };
    policy: { active: boolean };
  };
  assert.equal(status.appleNetworkAccessed, false);
  assert.deepEqual(status.status, {
    outcome: "delivered",
    guid: "delivery-guid",
    timestampMs: 123,
    source: "message-database",
  });
  assert.equal(status.policy.active, true);

  const repeated = await runCli([
    "ids-canary", "--profile", "secondary", "--data-root", dataRoot,
    "--native", join(root, "must-not-launch"), "--message", "duplicate", "friend@example.com",
  ], {});
  assert.equal(repeated.code, 1);
  assert.match(repeated.stderr, /already journaled.*Do not repeat/);
  assert.doesNotMatch(repeated.stderr, /ENOENT|must-not-launch/);

  // Reset only the synthetic fixture so the independent error-evidence branch
  // can run without weakening the production one-canary interlock.
  await rm(journalPath);
  await rm(join(profileRoot, "ids-policy.json"));

  const failed = await runCli([
    "ids-canary", "--profile", "secondary", "--data-root", dataRoot,
    "--native", executable, "--receipt-wait-seconds", "1",
    "--message", "error canary", "friend@example.com",
  ], { IBLUE_TEST_GUID: "error-guid", IBLUE_TEST_EVIDENCE: "error" });
  assert.equal(failed.code, 0, failed.stderr);
  assert.match(failed.stdout, /send error received from IDS.*status 47: Not delivered/);
  assert.match(failed.stdout, /Do not repeat this canary/);

  store = new BlueBubblesStore(join(profileRoot, "iblue.sqlite"), join(profileRoot, "attachments"));
  assert.equal(store.getMessage("error-guid")?.error, 47);
  assert.equal(store.getMessage("error-guid")?.isFromMe, true);
  store.close();

  const errorStatusResult = await runCli([
    "ids-canary-status", "--profile", "secondary", "--data-root", dataRoot, "--json",
  ], {});
  assert.equal(errorStatusResult.code, 0, errorStatusResult.stderr);
  const errorStatus = JSON.parse(errorStatusResult.stdout) as {
    status: { outcome: string; guid: string; errorStatus: number; source: string };
  };
  assert.deepEqual(errorStatus.status, {
    outcome: "error",
    guid: "error-guid",
    errorStatus: 47,
    source: "message-database",
  });
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

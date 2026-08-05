import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { BlueBubblesStore } from "../../src/bluebubbles/store.js";
import { profilePaths, saveIdsPolicy } from "../../src/profile.js";

test("outbound verification safety gates reject before launching native", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-outbound-policy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const paths = profilePaths("secondary", dataRoot);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await writeFile(paths.session, `${JSON.stringify({
    version: 1,
    profile: "secondary",
    deviceId: "device-id",
    apsState: "opaque-apns-state",
    users: "opaque-users",
    identity: "opaque-identity",
    accountUsername: "secondary@example.com",
    handles: ["mailto:secondary@example.com"],
    updatedAt: new Date(0).toISOString(),
  })}\n`, { mode: 0o600 });
  const store = new BlueBubblesStore(paths.database, paths.attachments);
  await store.ingestIncoming({
    uuid: "incoming-reference",
    sender: "tel:+16515550100",
    text: "reference",
    participants: ["tel:+16515550100"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    attachments: [],
  }, ["mailto:secondary@example.com"]);
  store.close();

  const missingConfirmation = await runCli([
    "outbound-verify",
    "--profile", "secondary",
    "--data-root", dataRoot,
    "--native", join(root, "must-not-launch"),
    "tel:+16515550100",
  ]);
  assert.equal(missingConfirmation.code, 1);
  assert.match(missingConfirmation.stderr, /--confirm-live/);
  assert.equal(missingConfirmation.stderr.includes("ENOENT"), false);

  await mkdir(paths.verification, { recursive: true, mode: 0o700 });
  const activePath = join(paths.verification, "outbound-active.json");
  await writeFile(activePath, "{\"state\":\"in-progress\"}\n", { mode: 0o600 });
  const unfinished = await runCli([
    "outbound-verify",
    "--profile", "secondary",
    "--data-root", dataRoot,
    "--native", join(root, "must-not-launch"),
    "--confirm-live",
    "tel:+16515550100",
  ]);
  assert.equal(unfinished.code, 1);
  assert.match(unfinished.stderr, /unfinished outbound verification journal/);
  assert.equal(unfinished.stderr.includes("ENOENT"), false);
  await rm(activePath);

  const completedPath = join(paths.verification, "outbound-prior.json");
  await writeFile(completedPath, "{\"state\":\"complete\"}\n", { mode: 0o600 });
  const completed = await runCli([
    "outbound-verify",
    "--profile", "secondary",
    "--data-root", dataRoot,
    "--native", join(root, "must-not-launch"),
    "--confirm-live",
    "tel:+16515550100",
  ]);
  assert.equal(completed.code, 1);
  assert.match(completed.stderr, /already completed/);
  assert.equal(completed.stderr.includes("ENOENT"), false);
  await rm(completedPath);

  await saveIdsPolicy(paths.idsPolicy, {
    version: 1,
    enabledAt: "2026-08-03T00:00:00.000Z",
    passiveUntil: "2099-08-04T00:00:00.000Z",
    reason: "test cooldown",
  });
  const cooldown = await runCli([
    "outbound-verify",
    "--profile", "secondary",
    "--data-root", dataRoot,
    "--native", join(root, "must-not-launch"),
    "--confirm-live",
    "tel:+16515550100",
  ]);
  assert.equal(cooldown.code, 1);
  assert.match(cooldown.stderr, /cooldown remains configured/);
  assert.equal(cooldown.stderr.includes("ENOENT"), false);
});

function runCli(args: string[]): Promise<{
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
        env: process.env,
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

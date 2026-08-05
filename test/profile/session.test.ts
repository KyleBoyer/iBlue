import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";

import {
  deleteIdsPolicy,
  idsPolicyActive,
  loadIdsPolicy,
  profilePaths,
  saveIdsPolicy,
  SessionStore,
} from "../../src/profile.js";
import type { EngineSnapshot } from "../../src/types.js";

test("profile paths isolate every account-owned state artifact", () => {
  const dataRoot = join(tmpdir(), "iblue-profile-layout-test");
  const first = profilePaths("first", dataRoot);
  const second = profilePaths("second", dataRoot);

  assert.equal(first.root, join(resolve(dataRoot), "profiles", "first"));
  assert.equal(second.root, join(resolve(dataRoot), "profiles", "second"));
  for (const key of Object.keys(first) as Array<keyof typeof first>) {
    assert.notEqual(first[key], second[key], `${key} must differ across profiles`);
    assert.equal(isAbsolute(first[key]), true, `${key} must be absolute`);
    const withinFirst = relative(first.root, first[key]);
    assert.equal(
      withinFirst === "" || (!withinFirst.startsWith("..") && !isAbsolute(withinFirst)),
      true,
      `${key} must remain beneath the selected profile root`,
    );
  }
  for (const invalid of ["../escape", "/absolute", ".leading", "two profiles", "a/b"]) {
    assert.throws(() => profilePaths(invalid, dataRoot), /profile must start/);
  }
});

test("profile sessions persist transport state without Apple credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-session-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "secondary", "session.json");
  const store = new SessionStore("secondary", path);
  const snapshot: EngineSnapshot = {
    protocolVersion: "1",
    deviceId: "device-id",
    apsState: "opaque-apns-state",
    users: "opaque-users",
    identity: "opaque-identity",
    accountUsername: "secondary@example.com",
    credentialBackend: "encrypted-file",
    idsMode: "normal",
    handles: ["mailto:secondary@example.com"],
    clientStarted: true,
    secondsSinceLastInbound: 0,
  };

  await store.save(snapshot);

  const serialized = await readFile(path, "utf8");
  assert.equal(serialized.includes("hashedPasswordHex"), false);
  assert.equal(serialized.includes("\"pet\""), false);
  assert.equal(serialized.includes("spdBase64"), false);
  assert.deepEqual(await store.load(), JSON.parse(serialized));
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  await store.delete();
  assert.equal(await store.load(), undefined);
  await store.delete();
});

test("profile IDS cooldown policies are private, durable, and time bounded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-ids-policy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "secondary", "ids-policy.json");
  const policy = {
    version: 1 as const,
    enabledAt: "2026-08-03T00:00:00.000Z",
    passiveUntil: "2026-08-04T00:00:00.000Z",
    reason: "test cooldown",
  };

  await saveIdsPolicy(path, policy);
  assert.deepEqual(await loadIdsPolicy(path), policy);
  assert.equal(idsPolicyActive(policy, Date.parse("2026-08-03T12:00:00.000Z")), true);
  assert.equal(idsPolicyActive(policy, Date.parse(policy.passiveUntil)), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }

  await deleteIdsPolicy(path);
  assert.equal(await loadIdsPolicy(path), undefined);
});

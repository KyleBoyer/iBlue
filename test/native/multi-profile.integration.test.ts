import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NativeEngine } from "../../src/native/engine.js";

const enabled = process.platform === "darwin" && process.env.IBLUE_NATIVE_INTEGRATION === "1";

test("two native profiles initialize as isolated APNs devices", { skip: !enabled, timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "iblue-isolation-"));
  const binaryPath = process.env.IBLUE_NATIVE_PATH
    ?? join(process.cwd(), "pkg", "rustpushgo", "target", "release", "iblue-native");
  await access(binaryPath);
  const credentialKeyFile = join(root, "credential.key");
  await writeFile(credentialKeyFile, randomBytes(32), { mode: 0o600 });

  const stateA = join(root, "profile-a");
  const stateB = join(root, "profile-b");
  const engineA = new NativeEngine({ stateDir: stateA, binaryPath, credentialKeyFile, requestTimeoutMs: 90_000 });
  const engineB = new NativeEngine({ stateDir: stateB, binaryPath, credentialKeyFile, requestTimeoutMs: 90_000 });
  try {
    const version = await engineA.version();
    assert.equal(version.platform, "macos");
    assert.equal(version.registrationAvailable, true);
    assert.equal(version.registrationBackend, "apple-aaabsinthe-framework");
    const [snapshotA, snapshotB] = await Promise.all([engineA.initialize({}), engineB.initialize({})]);
    // Both profiles run on the same real Mac, so they intentionally share its
    // hardware-derived device identifier. Their APNs credentials/state must not
    // be shared; Apple accounts and IDS registrations live above that boundary.
    assert.equal(snapshotA.deviceId, snapshotB.deviceId);
    assert.notEqual(snapshotA.apsState, snapshotB.apsState);
    assert.equal(snapshotA.credentialBackend, "encrypted-file");
    assert.equal(snapshotB.credentialBackend, "encrypted-file");
    assert.deepEqual(snapshotA.handles, []);
    assert.deepEqual(snapshotB.handles, []);

    const [filesA, filesB] = await Promise.all([
      readdir(stateA, { recursive: true }),
      readdir(stateB, { recursive: true }),
    ]);
    assert.ok(filesA.length > 0, "profile A should own native state files");
    assert.ok(filesB.length > 0, "profile B should own native state files");

    // Local-only logout is safe to exercise without an Apple account. It must
    // be idempotent when no credential record exists and must not affect the
    // other profile's isolated native process.
    assert.deepEqual(await engineA.logout(false), {
      deregistered: false,
      credentialDeleted: true,
    });
    assert.equal((await engineB.snapshot()).deviceId, snapshotB.deviceId);
  } finally {
    await Promise.allSettled([engineA.close(), engineB.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

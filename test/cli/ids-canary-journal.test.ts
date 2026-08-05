import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  archiveIdsCanaryJournal,
  beginIdsCanaryJournal,
  createIdsCanaryHoldPolicy,
  finishIdsCanaryJournal,
  loadIdsCanaryJournal,
  resolveIdsCanaryOfflineStatus,
  saveIdsCanaryJournal,
} from "../../src/ids-canary-journal.js";
import type { IdsCanaryResult } from "../../src/ids-probe.js";

const lookup = {
  available: ["mailto:friend@example.com", "mailto:me@example.com"],
  targets: [
    {
      address: "mailto:friend@example.com",
      cacheEntryFresh: true,
      responseEntryReturned: true,
      identityCount: 1,
      correlationIdentifierPresent: true,
    },
    {
      address: "mailto:me@example.com",
      cacheEntryFresh: true,
      responseEntryReturned: true,
      identityCount: 1,
      correlationIdentifierPresent: true,
    },
  ],
  error: null,
  panicked: false,
  timedOut: false,
  attempts: 1,
};

function acceptedResult(guid?: string): IdsCanaryResult {
  return {
    target: "mailto:friend@example.com",
    sender: "mailto:me@example.com",
    message: "secret canary text",
    targetAvailable: Boolean(guid),
    senderAvailable: Boolean(guid),
    targetLookup: lookup.targets[0]!,
    senderLookup: lookup.targets[1]!,
    lookup: guid ? lookup : {
      ...lookup,
      available: [],
      targets: lookup.targets.map((target) => ({ ...target, identityCount: 0 })),
    },
    ...(guid ? { guid } : {}),
  };
}

test("canary journal is private, omits message plaintext, and archives after recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-canary-journal-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "profile", "ids-canary.json");
  const started = beginIdsCanaryJournal({
    profile: "secondary",
    target: "mailto:friend@example.com",
    sender: "mailto:me@example.com",
    message: "secret canary text",
    now: new Date("2026-08-04T21:12:28.000Z"),
    id: "run-one",
  });
  await saveIdsCanaryJournal(path, started);
  const serialized = await readFile(path, "utf8");
  assert.equal(serialized.includes("secret canary text"), false);
  assert.match(started.messageSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await loadIdsCanaryJournal(path), started);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);

  const noSend = finishIdsCanaryJournal(
    started,
    acceptedResult(),
    undefined,
    new Date("2026-08-04T21:12:29.000Z"),
  );
  await saveIdsCanaryJournal(path, noSend);
  assert.deepEqual(resolveIdsCanaryOfflineStatus(noSend), {
    outcome: "not-sent",
    source: "journal",
  });
  const archive = await archiveIdsCanaryJournal(path, noSend);
  assert.equal(await loadIdsCanaryJournal(path), undefined);
  assert.deepEqual(await loadIdsCanaryJournal(archive), noSend);
});

test("late database receipts supersede the bounded canary observation window", () => {
  const started = beginIdsCanaryJournal({
    profile: "secondary",
    target: "mailto:friend@example.com",
    sender: "mailto:me@example.com",
    message: "secret canary text",
    now: new Date("2026-08-04T21:12:28.000Z"),
    id: "run-two",
  });
  const accepted = finishIdsCanaryJournal(
    started,
    acceptedResult("message-guid"),
    { kind: "timeout" },
    new Date("2026-08-04T21:12:58.000Z"),
  );
  assert.deepEqual(resolveIdsCanaryOfflineStatus(accepted), {
    outcome: "transport-accepted",
    guid: "message-guid",
    source: "journal",
  });
  assert.deepEqual(resolveIdsCanaryOfflineStatus(accepted, {
    guid: "message-guid",
    error: 0,
    dateRead: null,
    dateDelivered: 100,
    isDelivered: true,
  }), {
    outcome: "delivered",
    guid: "message-guid",
    timestampMs: 100,
    source: "message-database",
  });
  assert.deepEqual(resolveIdsCanaryOfflineStatus(accepted, {
    guid: "message-guid",
    error: 0,
    dateRead: 200,
    dateDelivered: 100,
    isDelivered: true,
  }), {
    outcome: "read",
    guid: "message-guid",
    timestampMs: 200,
    source: "message-database",
  });
});

test("canary hold policy is bounded and starts before live evidence is known", () => {
  const now = new Date("2026-08-04T21:12:28.000Z");
  const policy = createIdsCanaryHoldPolicy(72, now);
  assert.equal(Date.parse(policy.passiveUntil) - now.getTime(), 72 * 60 * 60 * 1_000);
  assert.match(policy.reason, /hold passive mode/);
  assert.throws(() => createIdsCanaryHoldPolicy(0, now), /greater than 0/);
  assert.throws(() => createIdsCanaryHoldPolicy(721, now), /no more than 720/);
});

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FaceTimeAutoAnswerRules } from "../../src/bluebubbles/facetime-auto-answer.js";
import { BlueBubblesStore } from "../../src/bluebubbles/store.js";

async function harness(t: { after: (fn: () => void) => void }) {
  const root = await mkdtemp(join(tmpdir(), "iblue-auto-answer-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  const rules = new FaceTimeAutoAnswerRules({
    store,
    mediaRoot: join(root, "attachments", "facetime-auto-answer"),
  });
  let created = 0;
  const withMedia = async () => {
    created += 1;
    const directory = await rules.prepareMediaDirectory(`media-${created}`);
    const path = join(directory, "clip.mp4");
    await writeFile(path, "fixture");
    return { filename: "clip.mp4", mimeType: "video/mp4", size: 7, path };
  };
  return { root, store, rules, withMedia };
}

const draft = {
  callers: [] as string[],
  mode: "any" as const,
  displayName: "iBlue",
  maxDurationSeconds: 90,
};

test("a rule answers only the callers and call modes it was configured for", async (t) => {
  const { rules, withMedia } = await harness(t);
  rules.create(
    { ...draft, name: "dad video", callers: ["tel:+15550001111"], mode: "video" },
    await withMedia(),
  );

  assert.equal(
    rules.match({ mode: "video", addresses: ["tel:+15550001111"] })?.name,
    "dad video",
  );
  // Right caller, wrong mode.
  assert.equal(rules.match({ mode: "audio", addresses: ["tel:+15550001111"] }), undefined);
  // Right mode, wrong caller.
  assert.equal(rules.match({ mode: "video", addresses: ["tel:+15559999999"] }), undefined);
});

test("mode any matches audio and video, and an empty caller list matches everyone", async (t) => {
  const { rules, withMedia } = await harness(t);
  rules.create({ ...draft, name: "catch all" }, await withMedia());

  for (const mode of ["audio", "video"] as const) {
    assert.equal(rules.match({ mode, addresses: ["mailto:stranger@example.com"] })?.name, "catch all");
  }
});

test("a caller-specific rule outranks a catch-all at the same priority", async (t) => {
  const { rules, withMedia } = await harness(t);
  // Created first, so insertion order would pick the wrong one.
  rules.create({ ...draft, name: "catch all" }, await withMedia());
  rules.create({ ...draft, name: "specific", callers: ["tel:+15550001111"] }, await withMedia());

  assert.equal(rules.match({ mode: "video", addresses: ["tel:+15550001111"] })?.name, "specific");
  assert.equal(rules.match({ mode: "video", addresses: ["tel:+15552223333"] })?.name, "catch all");
});

test("explicit priority beats specificity", async (t) => {
  const { rules, withMedia } = await harness(t);
  rules.create({ ...draft, name: "specific", callers: ["tel:+15550001111"] }, await withMedia());
  rules.create({ ...draft, name: "urgent catch all", priority: -10 }, await withMedia());

  assert.equal(
    rules.match({ mode: "video", addresses: ["tel:+15550001111"] })?.name,
    "urgent catch all",
  );
});

test("a disabled rule never matches", async (t) => {
  const { rules, withMedia } = await harness(t);
  const rule = rules.create({ ...draft, name: "off", enabled: false }, await withMedia());
  assert.equal(rules.match({ mode: "video", addresses: [] }), undefined);

  await rules.update(rule.id, { enabled: true });
  assert.equal(rules.match({ mode: "video", addresses: [] })?.name, "off");
});

test("a partial update leaves unmentioned fields alone", async (t) => {
  const { rules, withMedia } = await harness(t);
  const rule = rules.create(
    { ...draft, name: "original", callers: ["tel:+15550001111"], maxDurationSeconds: 120 },
    await withMedia(),
  );

  const updated = await rules.update(rule.id, { name: "renamed" });
  assert.equal(updated?.name, "renamed");
  assert.deepEqual(updated?.callers, ["tel:+15550001111"]);
  assert.equal(updated?.maxDurationSeconds, 120);
  assert.equal(updated?.mode, "any");
});

test("replacing media removes the previous file and keeps the rule playable", async (t) => {
  const { rules, withMedia } = await harness(t);
  const first = await withMedia();
  const rule = rules.create({ ...draft }, first);
  assert.equal(rules.mediaPath(rule.id), first.path);

  const second = await withMedia();
  await rules.update(rule.id, {}, second);

  assert.equal(rules.mediaPath(rule.id), second.path);
  assert.equal(existsSync(second.path), true);
  assert.equal(existsSync(first.path), false, "superseded media should not linger");
});

test("deleting a rule removes its stored media", async (t) => {
  const { rules, withMedia } = await harness(t);
  const media = await withMedia();
  const rule = rules.create({ ...draft }, media);

  assert.equal((await rules.delete(rule.id))?.id, rule.id);
  assert.equal(rules.get(rule.id), undefined);
  assert.equal(existsSync(media.path), false);
  assert.equal(await rules.delete(rule.id), undefined, "deleting twice is not an error");
});

test("rules and their answer counters survive a store reopen", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-auto-answer-durable-"));
  const databasePath = join(root, "test.sqlite");
  const attachments = join(root, "attachments");
  const mediaRoot = join(attachments, "facetime-auto-answer");

  const first = new BlueBubblesStore(databasePath, attachments);
  const firstRules = new FaceTimeAutoAnswerRules({ store: first, mediaRoot });
  const directory = await firstRules.prepareMediaDirectory("media-1");
  const path = join(directory, "clip.mp4");
  await writeFile(path, "fixture");
  const rule = firstRules.create(
    { ...draft, name: "kept", callers: ["tel:+15550001111"], mode: "video" },
    { filename: "clip.mp4", mimeType: "video/mp4", size: 7, path },
  );
  firstRules.recordAnswered(rule.id);
  first.close();

  const second = new BlueBubblesStore(databasePath, attachments);
  t.after(() => second.close());
  const secondRules = new FaceTimeAutoAnswerRules({ store: second, mediaRoot });

  const restored = secondRules.match({ mode: "video", addresses: ["tel:+15550001111"] });
  assert.equal(restored?.name, "kept");
  assert.equal(restored?.answerCount, 1);
  assert.notEqual(restored?.lastAnsweredAt, null);
  assert.equal(secondRules.mediaPath(restored!.id), path);
});

test("stored media never escapes the profile media root on delete", async (t) => {
  const { root, store, rules } = await harness(t);
  const outside = join(root, "outside.mp4");
  await writeFile(outside, "fixture");
  const rule = store.createAutoAnswerRule({
    callers: [],
    mode: "any",
    displayName: "iBlue",
    maxDurationSeconds: 90,
    mediaPath: outside,
    mediaFilename: "outside.mp4",
    mediaMime: "video/mp4",
    mediaSize: 7,
  });

  await rules.delete(rule.id);
  assert.equal(existsSync(outside), true, "a path outside the media root must not be deleted");
});

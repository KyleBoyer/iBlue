import assert from "node:assert/strict";
import test from "node:test";

import {
  effectIdForMessageFlair,
  MESSAGE_FLAIRS,
  messageFlairFromEffectId,
} from "../../src/bluebubbles/message-flair.js";

test("friendly message flair names resolve to Apple wire identifiers", () => {
  assert.equal(
    effectIdForMessageFlair("confetti"),
    "com.apple.messages.effect.CKConfettiEffect",
  );
  assert.equal(
    effectIdForMessageFlair("Invisible Ink"),
    "com.apple.MobileSMS.expressivesend.invisibleink",
  );
  assert.equal(
    effectIdForMessageFlair("sparkles"),
    "com.apple.messages.effect.CKSparklesEffect",
  );
  assert.equal(effectIdForMessageFlair("not-an-effect"), undefined);
  assert.equal(MESSAGE_FLAIRS.length, 13);
});

test("received message flair is normalized without losing unknown effect IDs", () => {
  assert.deepEqual(messageFlairFromEffectId("com.apple.messages.effect.CKConfettiEffect"), {
    name: "confetti",
    displayName: "Confetti",
    category: "screen",
    effectId: "com.apple.messages.effect.CKConfettiEffect",
    known: true,
  });
  assert.deepEqual(messageFlairFromEffectId("com.apple.messages.effect.CKFutureEffect"), {
    name: "unknown",
    displayName: "Unknown",
    category: "unknown",
    effectId: "com.apple.messages.effect.CKFutureEffect",
    known: false,
  });
});

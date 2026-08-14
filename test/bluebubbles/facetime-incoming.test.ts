import assert from "node:assert/strict";
import test from "node:test";

import { parseIncomingFaceTimeSignal } from "../../src/bluebubbles/service.js";

const base = {
  uuid: "facetime-event",
  participants: ["tel:+12025550142"],
  timestampMs: 1,
  isSms: false,
  isStoredMessage: false,
  attachments: [],
};

test("incoming FaceTime ring markers become stable session lifecycle signals", () => {
  assert.deepEqual(parseIncomingFaceTimeSignal({
    ...base,
    text: "[[FACETIME_RING]] guid=0f4a9b1c-1111-2222-3333-444444444444 https://facetime.apple.com/join#fixture",
  }), {
    sessionId: "0F4A9B1C-1111-2222-3333-444444444444",
    state: "ringing",
  });
  assert.deepEqual(parseIncomingFaceTimeSignal({
    ...base,
    text: "[[FACETIME_MISSED]] guid=0F4A9B1C-1111-2222-3333-444444444444",
  }), {
    sessionId: "0F4A9B1C-1111-2222-3333-444444444444",
    state: "declined",
  });
  assert.deepEqual(parseIncomingFaceTimeSignal({
    ...base,
    text: "[[FACETIME_ANSWERED_ELSEWHERE]] guid=0F4A9B1C-1111-2222-3333-444444444444",
  }), {
    sessionId: "0F4A9B1C-1111-2222-3333-444444444444",
    state: "answered-elsewhere",
  });
  assert.equal(parseIncomingFaceTimeSignal({ ...base, text: "ordinary message" }), undefined);
});

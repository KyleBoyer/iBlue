import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  evidenceForCanaryMessage,
  IdsCanaryReceiptMonitor,
} from "../../src/ids-canary-receipt.js";
import type { IncomingMessage } from "../../src/types.js";

function control(overrides: Partial<IncomingMessage>): IncomingMessage {
  return {
    uuid: "unrelated",
    participants: [],
    timestampMs: 123,
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    ...overrides,
  };
}

test("canary receipt monitor buffers evidence that arrives before the send GUID", async (t) => {
  const source = new EventEmitter();
  const monitor = new IdsCanaryReceiptMonitor(source);
  t.after(() => monitor.close());

  source.emit("message.received", control({ uuid: "CANARY-GUID", delivered: true }));
  assert.deepEqual(await monitor.waitFor("canary-guid", 1_000), {
    kind: "delivered",
    timestampMs: 123,
  });
});

test("canary receipt monitor correlates error forUuid instead of its envelope UUID", async (t) => {
  const source = new EventEmitter();
  const monitor = new IdsCanaryReceiptMonitor(source);
  t.after(() => monitor.close());

  const pending = monitor.waitFor("message-guid", 1_000);
  source.emit("message.received", control({
    uuid: "error-envelope-guid",
    error: { forUuid: "MESSAGE-GUID", status: 47, message: "Not delivered" },
  }));
  assert.deepEqual(await pending, {
    kind: "error",
    timestampMs: 123,
    status: 47,
    message: "Not delivered",
  });
});

test("read receipts supersede delivered and unrelated controls do not match", () => {
  assert.equal(evidenceForCanaryMessage(control({ uuid: "other", delivered: true }), "wanted"), undefined);
  assert.deepEqual(
    evidenceForCanaryMessage(control({ uuid: "wanted", delivered: true, readReceipt: true }), "wanted"),
    { kind: "read", timestampMs: 123 },
  );
});

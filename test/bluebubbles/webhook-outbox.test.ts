import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BlueBubblesStore } from "../../src/bluebubbles/store.js";

test("webhook deliveries persist across restart and remain ordered per endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "iblue-webhook-outbox-"));
  const databasePath = join(root, "messages.sqlite");
  const attachmentRoot = join(root, "attachments");
  let store = new BlueBubblesStore(databasePath, attachmentRoot);

  try {
    const webhook = store.createWebhook("https://example.invalid/incoming", ["new-message"]);
    assert.equal(store.enqueueWebhookDeliveries(
      [webhook.id],
      { type: "new-message", data: { guid: "first-guid" } },
    ), 1);
    assert.equal(store.enqueueWebhookDeliveries(
      [webhook.id],
      { type: "new-message", data: { guid: "second-guid" } },
    ), 1);
    assert.equal(store.webhookDeliveryCount(), 2);

    store.close();
    store = new BlueBubblesStore(databasePath, attachmentRoot);

    const first = store.dueWebhookDeliveries()[0];
    assert.ok(first);
    assert.equal((first.payload as { data: { guid: string } }).data.guid, "first-guid");
    assert.equal(store.dueWebhookDeliveries().length, 1, "later events must wait behind the endpoint head");

    const retryAt = Date.now() + 60_000;
    store.recordWebhookDeliveryFailure({
      id: first.id,
      error: "HTTP 503",
      nextAttemptAt: retryAt,
      terminal: false,
    });
    assert.equal(store.dueWebhookDeliveries().length, 0);
    assert.equal(store.nextWebhookDeliveryAt(), retryAt);

    store.recordWebhookDeliveryFailure({
      id: first.id,
      error: "retry budget exhausted",
      nextAttemptAt: retryAt,
      terminal: true,
    });
    const second = store.dueWebhookDeliveries()[0];
    assert.ok(second);
    assert.equal((second.payload as { data: { guid: string } }).data.guid, "second-guid");
    store.completeWebhookDelivery(second.id);
    assert.equal(store.webhookDeliveryCount(), 0);
    assert.equal(store.webhookDeliveryCount({ includeFailed: true }), 1);

    assert.equal(store.deleteWebhook(webhook.id), true);
    assert.equal(store.webhookDeliveryCount({ includeFailed: true }), 0, "webhook deletion cascades to its outbox");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

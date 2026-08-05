import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BlueBubblesStore } from "../../src/bluebubbles/store.js";
import type { IncomingMessage } from "../../src/types.js";

test("profile message database files are private", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-store-permissions-test-"));
  const databasePath = join(root, "test.sqlite");
  const store = new BlueBubblesStore(databasePath, join(root, "attachments"));
  t.after(() => store.close());
  if (process.platform === "win32") return;
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600, path);
  }
});

test("IDS send errors update the correlated outgoing message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-store-send-error-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  store.ensureDirectChat("iMessage;-;friend@example.com", {
    participants: ["mailto:friend@example.com"],
  });
  store.insertOutgoing({
    guid: "outgoing-guid",
    chatGuid: "iMessage;-;friend@example.com",
    text: "hello",
  });

  const updated = store.markMessageError("outgoing-guid", {
    forUuid: "outgoing-guid",
    status: 47,
    message: "Not delivered",
  });
  assert.equal(updated?.guid, "outgoing-guid");
  assert.equal(updated?.error, 47);
  assert.equal(updated?.isFromMe, true);
  assert.equal(store.markMessageError("outgoing-guid", {
    forUuid: "outgoing-guid",
    status: 47,
    message: "Not delivered",
  }), undefined);
  assert.equal(store.getMessage("unknown"), undefined);
  assert.equal(store.markMessageError("unknown", { status: 47 }), undefined);
});

test("duplicate delivery and read controls do not create repeated state transitions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-store-receipt-idempotency-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  store.ensureDirectChat("iMessage;-;friend@example.com", {
    participants: ["mailto:friend@example.com"],
  });
  store.insertOutgoing({
    guid: "receipt-guid",
    chatGuid: "iMessage;-;friend@example.com",
    text: "hello",
  });

  assert.ok(store.markMessageDelivered("receipt-guid", 100));
  assert.equal(store.markMessageDelivered("receipt-guid", 101), undefined);
  assert.ok(store.markMessageRead("receipt-guid", 200));
  assert.equal(store.markMessageRead("receipt-guid", 201), undefined);
  assert.equal(store.getMessage("receipt-guid")?.dateDelivered, 100);
  assert.equal(store.getMessage("receipt-guid")?.dateRead, 200);
});

test("incoming event claims reclaim crashes, survive completion, and release failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "iblue-store-event-claim-test-"));
  const databasePath = join(root, "test.sqlite");
  const attachmentRoot = join(root, "attachments");
  const incoming: IncomingMessage = {
    uuid: "replayed-guid",
    sender: "mailto:friend@example.com",
    text: "only once",
    participants: ["mailto:friend@example.com"],
    timestampMs: 100,
    isSms: false,
    isStoredMessage: true,
    attachments: [],
  };
  let store = new BlueBubblesStore(databasePath, attachmentRoot);
  const key = store.claimIncomingEvent(incoming);
  assert.equal(key, "message:replayed-guid");
  assert.equal(store.claimIncomingEvent(incoming), undefined);
  store.close();

  // The first owner closed without completion, modeling a process crash.
  store = new BlueBubblesStore(databasePath, attachmentRoot);
  assert.equal(store.claimIncomingEvent(incoming), key);
  store.completeIncomingEvent(key!);
  store.close();

  store = new BlueBubblesStore(databasePath, attachmentRoot);
  assert.equal(store.claimIncomingEvent(incoming), undefined);
  const retryable = { ...incoming, uuid: "retryable-guid" };
  const retryableKey = store.claimIncomingEvent(retryable);
  assert.equal(retryableKey, "message:retryable-guid");
  store.releaseIncomingEvent(retryableKey!);
  assert.equal(store.claimIncomingEvent(retryable), retryableKey);
  store.close();
});

test("incoming IDS messages serialize to stable BlueBubbles payloads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-store-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  const incoming: IncomingMessage = {
    uuid: "message-guid-1",
    sender: "mailto:friend@example.com",
    text: "hello",
    participants: ["mailto:friend@example.com"],
    timestampMs: 1_725_000_000_000,
    isSms: false,
    isStoredMessage: false,
    attachments: [
      {
        mimeType: "image/png",
        filename: "pixel.png",
        utiType: "public.png",
        size: 3,
        isInline: true,
        dataBase64: Buffer.from([1, 2, 3]).toString("base64"),
        iris: false,
      },
    ],
  };

  const result = await store.ingestIncoming(incoming, ["mailto:me@example.com"]);
  assert.equal(result.guid, incoming.uuid);
  assert.equal(result.handle?.address, "friend@example.com");
  assert.equal(result.isFromMe, false);
  assert.equal(result.chats?.[0]?.guid, "iMessage;-;friend@example.com");
  assert.equal(result.attachments[0]?.mimeType, "image/png");

  const attachment = store.getAttachment(result.attachments[0]!.guid);
  assert.ok(attachment?.path);
  assert.deepEqual(await readFile(attachment.path), Buffer.from([1, 2, 3]));

  const queried = store.queryMessages({ chatGuid: "iMessage;-;friend@example.com" });
  assert.equal(queried.total, 1);
  assert.equal(queried.messages[0]?.originalROWID, result.originalROWID);
});

test("tapbacks use BlueBubbles associated message types", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-reaction-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  const reaction: IncomingMessage = {
    uuid: "reaction-guid",
    sender: "tel:+15555550100",
    participants: ["tel:+15555550100"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    verificationFailed: true,
    attachments: [{
      mimeType: "image/png",
      filename: "sticker.png",
      utiType: "public.png",
      size: 3,
      isInline: true,
      dataBase64: Buffer.from([7, 8, 9]).toString("base64"),
      iris: false,
      isSticker: true,
    }],
    tapback: { type: 1, targetUuid: "target-guid", targetPart: 0, remove: true },
  };
  const result = await store.ingestIncoming(reaction, []);
  assert.equal(result.associatedMessageGuid, "target-guid");
  assert.equal(result.associatedMessageType, "-like");
  assert.equal(result.iBlue?.senderVerificationFailed, true);
  assert.equal(store.getMessage("reaction-guid")?.iBlue?.senderVerificationFailed, true);
  assert.equal(result.attachments[0]?.isSticker, true);
  assert.deepEqual(await readFile(store.getAttachment(result.attachments[0]!.guid)!.path!), Buffer.from([7, 8, 9]));
});

test("sticker reactions use BlueBubbles' sticker association type", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-sticker-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  const result = await store.ingestIncoming({
    uuid: "sticker-reaction-guid",
    sender: "tel:+15555550100",
    participants: ["tel:+15555550100"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    tapback: { type: 7, targetUuid: "target-guid", targetPart: 0, remove: false },
  }, []);
  assert.equal(result.associatedMessageType, "sticker");
});

test("one-to-one IDS messages with a conversation UUID exclude the local handle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-direct-chat-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  const incoming: IncomingMessage = {
    uuid: "direct-message-guid",
    sender: "tel:+15555550100",
    text: "hello",
    participants: ["tel:+15555550100", "mailto:secondary@example.com"],
    senderGuid: "CONVERSATION-UUID-PRESENT-ON-A-DIRECT-MESSAGE",
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    attachments: [],
  };

  const result = await store.ingestIncoming(incoming, ["mailto:secondary@example.com"]);
  const chat = result.chats?.[0];
  assert.ok(chat);
  assert.ok(chat.participants);
  assert.equal(chat.guid, "iMessage;-;+15555550100");
  assert.deepEqual(chat.participants.map((participant) => participant.address), [
    "+15555550100",
  ]);
});

test("IDS group messages retain their conversation UUID and other participants", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-group-chat-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  const incoming: IncomingMessage = {
    uuid: "group-message-guid",
    sender: "mailto:friend@example.com",
    text: "hello group",
    participants: [
      "mailto:friend@example.com",
      "tel:+15555550101",
      "mailto:secondary@example.com",
    ],
    senderGuid: "GROUP-CONVERSATION-UUID",
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    attachments: [],
  };

  const result = await store.ingestIncoming(incoming, ["mailto:secondary@example.com"]);
  const chat = result.chats?.[0];
  assert.ok(chat);
  assert.ok(chat.participants);
  assert.equal(chat.guid, "iMessage;+;GROUP-CONVERSATION-UUID");
  assert.deepEqual(chat.participants.map((participant) => participant.address), [
    "friend@example.com",
    "+15555550101",
  ]);
});

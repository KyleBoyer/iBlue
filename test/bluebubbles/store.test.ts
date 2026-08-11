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
    effect: "com.apple.messages.effect.CKConfettiEffect",
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
  assert.equal(result.expressiveSendStyleId, "com.apple.messages.effect.CKConfettiEffect");
  assert.deepEqual(result.iBlue?.messageFlair, {
    name: "confetti",
    displayName: "Confetti",
    category: "screen",
    effectId: "com.apple.messages.effect.CKConfettiEffect",
    known: true,
  });

  const attachment = store.getAttachment(result.attachments[0]!.guid);
  assert.ok(attachment?.path);
  assert.deepEqual(await readFile(attachment.path), Buffer.from([1, 2, 3]));

  const queried = store.queryMessages({ chatGuid: "iMessage;-;friend@example.com" });
  assert.equal(queried.total, 1);
  assert.equal(queried.messages[0]?.originalROWID, result.originalROWID);
});

test("Apple-provided audio transcriptions are exposed without synthesizing text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-audio-transcription-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  const result = await store.ingestIncoming({
    uuid: "audio-transcription-guid",
    sender: "mailto:friend@example.com",
    text: "\ufffc",
    participants: ["mailto:friend@example.com"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    isVoice: true,
    attachments: [{
      mimeType: "application/octet-stream",
      filename: "Audio Message.caf",
      utiType: "com.apple.coreaudio-format",
      size: 3,
      isInline: true,
      dataBase64: Buffer.from([1, 2, 3]).toString("base64"),
      iris: false,
      audioTranscription: "  Meet at five  ",
    }],
  }, []);

  assert.equal(result.isAudioMessage, true);
  assert.equal(result.text, "\ufffc");
  assert.deepEqual(result.iBlue?.audioTranscription, {
    text: "Meet at five",
    source: "apple",
  });
});

test("Apple Music shares expose structured rich-link metadata and downloadable artwork", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-rich-link-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  const url = "https://music.apple.com/us/album/way-too-self-aware-remix/6771198461?i=6771198463";
  const metadata = `${url}\x01${url}\x01Way Too Self Aware (Remix) — Ian Asher\x01\x01image/png`;
  const result = await store.ingestIncoming({
    uuid: "apple-music-rich-link-guid",
    sender: "mailto:friend@example.com",
    text: url,
    participants: ["mailto:friend@example.com"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    attachments: [
      {
        mimeType: "x-richlink/meta",
        filename: "",
        utiType: "",
        size: 0,
        isInline: true,
        dataBase64: Buffer.from(metadata).toString("base64"),
        iris: false,
      },
      {
        mimeType: "x-richlink/image",
        filename: "",
        utiType: "",
        size: 4,
        isInline: true,
        dataBase64: Buffer.from("art!").toString("base64"),
        iris: false,
      },
    ],
  }, []);

  assert.equal(result.balloonBundleId, "com.apple.messages.URLBalloonProvider");
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0]?.mimeType, "image/png");
  assert.equal(result.attachments[0]?.transferName, "rich-link-artwork.png");
  assert.deepEqual(result.attachments[0]?.metadata, { iBlueRichLinkArtwork: true });
  assert.deepEqual(result.iBlue?.richLink, {
    provider: "apple-music",
    originalUrl: url,
    url,
    title: "Way Too Self Aware (Remix) — Ian Asher",
    artwork: {
      attachmentGuid: result.attachments[0]?.guid,
      mimeType: "image/png",
    },
    appleMusic: {
      storefront: "us",
      resourceType: "song",
      catalogId: "6771198463",
      albumId: "6771198461",
      songId: "6771198463",
    },
  });

  const storedArtwork = store.getAttachment(result.attachments[0]!.guid);
  assert.equal(storedArtwork?.response.mimeType, "image/png");
  assert.ok(storedArtwork?.path);
  assert.deepEqual(await readFile(storedArtwork.path), Buffer.from("art!"));
});

test("iCloud Photos app balloons expose normalized share metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-icloud-share-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  const shareUrl = "https://share.icloud.com/photos/05dFixtureShareToken_1234567890";
  const result = await store.ingestIncoming({
    uuid: "icloud-share-guid",
    sender: "tel:+15555550100",
    text: "\ufffd\ufffc",
    participants: ["tel:+15555550100"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    appBalloon: {
      appName: "None",
      bundleId: "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.mobileslideshow.PhotosMessagesApp",
      url: shareUrl,
      isLive: true,
      caption: "Wednesday\u2009–\u2009Friday",
      subcaption: "4 Photos",
      ldText: "Wednesday\u2009–\u2009Friday - 4 Photos",
    },
  }, []);

  assert.equal(result.balloonBundleId?.endsWith("com.apple.mobileslideshow.PhotosMessagesApp"), true);
  assert.deepEqual(result.iBlue?.icloudShare, {
    provider: "icloud-photos",
    shareId: "05dFixtureShareToken_1234567890",
    url: shareUrl,
    isLive: true,
    caption: "Wednesday\u2009–\u2009Friday",
    itemCount: 4,
    photoCount: 4,
    bundleId: "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.mobileslideshow.PhotosMessagesApp",
  });
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

test("contact names enrich handles while VCF data takes precedence over shared profiles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-contact-store-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());

  store.upsertNameAndPhotoContact("mailto:friend@example.com", {
    displayName: "Shared Jane",
    firstName: "Jane",
    lastName: "Example",
    hasPoster: false,
    avatarBase64: "AQID",
  });
  store.replaceProfileVcfContacts([{
    addresses: ["friend@example.com"],
    displayName: "My Jane",
    firstName: "Jane",
    lastName: "Example",
    source: "profile-vcf",
  }]);
  store.ensureDirectChat("iMessage;-;friend@example.com", {
    participants: ["mailto:friend@example.com"],
  });

  const handle = store.getHandle("friend@example.com");
  assert.equal(handle?.iBlue?.contact?.displayName, "My Jane");
  assert.equal(handle?.iBlue?.contact?.source, "profile-vcf");
  assert.deepEqual(store.queryContacts({ search: "jane" }).contacts.map((contact) => contact.address), [
    "friend@example.com",
  ]);
  assert.equal(store.queryContacts({ search: "shared" }).total, 0);
  assert.equal(store.queryContacts({ sources: ["name-and-photo-sharing"] }).contacts[0]?.displayName, "Shared Jane");
  assert.deepEqual(store.getContactAvatar("friend@example.com")?.data, Buffer.from([1, 2, 3]));
});

test("Maps app balloons persist as iBlue shared-location message properties", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-location-store-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  const message = await store.ingestIncoming({
    uuid: "location-message-guid",
    sender: "mailto:friend@example.com",
    text: "\ufffc",
    participants: ["mailto:friend@example.com"],
    timestampMs: 1234,
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    appBalloon: {
      bundleId: "com.apple.Maps.MessagesExtension",
      appName: "Maps",
      url: "https://maps.apple.com/?ll=37.3349,-122.009",
      sessionId: "maps-session",
      isLive: false,
      imageTitle: "Apple Park",
      subcaption: "Cupertino, CA",
    },
  }, []);

  assert.equal(message.balloonBundleId, "com.apple.Maps.MessagesExtension");
  assert.deepEqual(message.iBlue?.sharedLocation, {
    latitude: 37.3349,
    longitude: -122.009,
    label: "Apple Park",
    address: "Cupertino, CA",
    url: "https://maps.apple.com/?ll=37.3349,-122.009",
    isLive: false,
    sessionId: "maps-session",
    bundleId: "com.apple.Maps.MessagesExtension",
  });
  assert.equal(store.getSharedLocation("location-message-guid")?.chatGuid, "iMessage;-;friend@example.com");
  assert.equal(store.querySharedLocations({ chatGuid: "iMessage;-;friend@example.com" }).total, 1);
  assert.equal(store.mediaTotals().locations, 1);
  assert.equal(store.mediaTotalsByChat()[0]?.totals.locations, 1);
});

test("plain Apple Maps URLs persist as static shared-location messages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-static-location-store-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  const url = "https://maps.apple.com/place?coordinate=37.334900,-122.009000&name=Dropped%20Pin";
  const message = await store.ingestIncoming({
    uuid: "static-location-message-guid",
    sender: "tel:+15555550101",
    text: url,
    participants: ["tel:+15555550101"],
    timestampMs: 5678,
    isSms: false,
    isStoredMessage: false,
    attachments: [],
  }, []);

  assert.deepEqual(message.iBlue?.sharedLocation, {
    latitude: 37.3349,
    longitude: -122.009,
    label: "Dropped Pin",
    url,
    isLive: false,
  });
});

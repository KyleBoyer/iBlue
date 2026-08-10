import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BlueBubblesServer } from "../../src/bluebubbles/server.js";
import { BlueBubblesService } from "../../src/bluebubbles/service.js";
import { BlueBubblesStore } from "../../src/bluebubbles/store.js";
import type { IMessageEngine } from "../../src/native/engine.js";
import {
  assertOutboundVerificationAllowed,
  runOutboundVerification,
} from "../../src/outbound-verification.js";
import { SessionStore } from "../../src/profile.js";
import type {
  EngineSnapshot,
  SendAttachmentParams,
  SendMessageParams,
  SendReactionParams,
  SendPollVoteParams,
  SendReadReceiptParams,
  SendTypingParams,
} from "../../src/types.js";

const snapshot: EngineSnapshot = {
  protocolVersion: "1",
  deviceId: "device-test",
  apsState: "aps",
  users: "users",
  identity: "identity",
  accountUsername: "secondary@example.com",
  credentialBackend: "encrypted-file",
  idsMode: "normal",
  handles: ["mailto:secondary@example.com"],
  clientStarted: true,
  secondsSinceLastInbound: 0,
};

class VerificationEngine extends EventEmitter {
  readonly messages: SendMessageParams[] = [];
  readonly reactions: SendReactionParams[] = [];
  readonly pollVotes: SendPollVoteParams[] = [];
  readonly typing: SendTypingParams[] = [];
  readonly reads: SendReadReceiptParams[] = [];
  readonly attachments: Array<{ params: SendAttachmentParams; data: Buffer }> = [];
  #nextGuid = 1;

  initialize(): Promise<EngineSnapshot> {
    return Promise.resolve(snapshot);
  }

  startClient(): Promise<EngineSnapshot> {
    return Promise.resolve(snapshot);
  }

  snapshot(): Promise<EngineSnapshot> {
    return Promise.resolve(snapshot);
  }

  health(): Promise<{ clientStarted: boolean; secondsSinceLastInbound: number }> {
    return Promise.resolve({ clientStarted: true, secondsSinceLastInbound: 0 });
  }

  sendMessage(params: SendMessageParams): Promise<{ guid: string }> {
    this.messages.push(params);
    return Promise.resolve(this.accept(`text-${this.#nextGuid++}`));
  }

  sendReaction(params: SendReactionParams): Promise<{ guid: string }> {
    this.reactions.push(params);
    return Promise.resolve(this.accept(`reaction-${this.#nextGuid++}`));
  }

  sendPollVote(params: SendPollVoteParams): Promise<{ guid: string }> {
    this.pollVotes.push(params);
    return Promise.resolve(this.accept(`poll-vote-${this.#nextGuid++}`));
  }

  async sendAttachment(params: SendAttachmentParams): Promise<{ guid: string }> {
    this.attachments.push({ params, data: await readFile(params.path) });
    return this.accept(`attachment-${this.#nextGuid++}`);
  }

  sendTyping(params: SendTypingParams): Promise<{ sent: boolean }> {
    this.typing.push(params);
    return Promise.resolve({ sent: true });
  }

  sendReadReceipt(params: SendReadReceiptParams): Promise<{ sent: boolean }> {
    this.reads.push(params);
    return Promise.resolve({ sent: true });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private accept(guid: string): { guid: string } {
    queueMicrotask(() => this.emit("message.received", {
      uuid: guid,
      participants: [],
      timestampMs: Date.now(),
      isSms: false,
      isStoredMessage: false,
      attachments: [],
      delivered: true,
    }));
    return { guid };
  }
}

test("outbound verification guard requires deliberate post-canary state", () => {
  assert.throws(
    () => assertOutboundVerificationAllowed({ confirmed: false, referenceIncomingGuid: "incoming" }),
    /--confirm-live/,
  );
  assert.throws(
    () => assertOutboundVerificationAllowed({
      confirmed: true,
      referenceIncomingGuid: "incoming",
      policy: {
        version: 1,
        enabledAt: "2026-08-03T00:00:00.000Z",
        passiveUntil: "2026-08-04T00:00:00.000Z",
        reason: "test",
      },
    }),
    /cooldown remains configured/,
  );
  assert.throws(
    () => assertOutboundVerificationAllowed({ confirmed: true }),
    /requires an existing incoming message/,
  );
  assert.equal(
    assertOutboundVerificationAllowed({ confirmed: true, referenceIncomingGuid: "incoming" }),
    "incoming",
  );
});

test("outbound verifier exercises real BlueBubbles REST routes and records receipt evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-outbound-verification-test-"));
  const engine = new VerificationEngine();
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  const sessions = new SessionStore("test", join(root, "session.json"));
  const service = new BlueBubblesService({
    profile: "test",
    password: "verification-secret",
    engine: engine as unknown as IMessageEngine,
    store,
    sessionStore: sessions,
  });
  const api = new BlueBubblesServer({ service, host: "127.0.0.1", port: 0 });
  let apiStarted = false;
  let serviceStarted = false;
  t.after(async () => {
    if (apiStarted) await api.stop();
    if (serviceStarted) await service.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  await store.ingestIncoming({
    uuid: "incoming-reference",
    sender: "mailto:friend@example.com",
    text: "react and reply to me",
    participants: ["mailto:friend@example.com"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    attachments: [],
  }, snapshot.handles);
  await service.start({
    version: 1,
    profile: "test",
    deviceId: snapshot.deviceId,
    apsState: snapshot.apsState,
    users: snapshot.users!,
    identity: snapshot.identity!,
    accountUsername: snapshot.accountUsername!,
    handles: snapshot.handles,
    updatedAt: new Date().toISOString(),
  });
  serviceStarted = true;
  const listening = await api.start();
  apiStarted = true;

  const checkpoints: Array<{
    state: string;
    completedAt?: string;
    steps: Array<{ feature: string; receipt?: string }>;
  }> = [];
  const report = await runOutboundVerification({
    address: listening.address,
    password: "verification-secret",
    profile: "test",
    target: "mailto:friend@example.com",
    chatGuid: "iMessage;-;friend@example.com",
    referenceIncomingGuid: "incoming-reference",
    receiptWaitSeconds: 1,
    typingDurationMs: 0,
    pollIntervalMs: 10,
    runId: "contract",
    onProgress: (progress) => {
      checkpoints.push(JSON.parse(JSON.stringify(progress)) as typeof checkpoints[number]);
    },
  });

  assert.deepEqual(report.steps.map(({ feature }) => feature), [
    "typing-start",
    "typing-stop",
    "read-receipt",
    "text",
    "reply",
    "reaction",
    "image",
  ]);
  assert.equal(report.steps.every(({ apiAccepted }) => apiAccepted), true);
  assert.deepEqual(checkpoints.map(({ steps }) => steps.length), [0, 1, 2, 3, 4, 5, 6, 7, 7]);
  assert.equal(checkpoints[0]?.state, "in-progress");
  assert.equal(checkpoints[0]?.completedAt, undefined);
  assert.equal(checkpoints.at(-1)?.state, "complete");
  assert.ok(checkpoints.at(-1)?.completedAt);
  assert.deepEqual(
    checkpoints.at(-1)?.steps.filter(({ receipt }) => receipt).map(({ receipt }) => receipt),
    ["delivered", "delivered", "delivered", "delivered"],
  );
  assert.deepEqual(
    report.steps.filter(({ guid }) => guid).map(({ receipt }) => receipt),
    ["delivered", "delivered", "delivered", "delivered"],
  );
  assert.deepEqual(engine.typing.map(({ active }) => active), [true, false]);
  assert.equal(engine.reads[0]?.forUuid, "incoming-reference");
  assert.equal(engine.messages.length, 2);
  assert.equal(engine.messages[0]?.text, "iBlue outbound verification text [contract]");
  assert.equal(engine.messages[1]?.replyGuid, "incoming-reference");
  assert.equal(engine.messages[1]?.replyPart, "0");
  assert.equal(engine.reactions[0]?.reaction, "laugh");
  assert.equal(engine.reactions[0]?.targetUuid, "incoming-reference");
  assert.equal(engine.attachments.length, 1);
  assert.deepEqual(
    engine.attachments[0]?.data.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert.equal(engine.attachments[0]?.params.mimeType, "image/png");
  assert.equal(report.target, "mailto:friend@example.com");
  assert.equal(report.referenceIncomingGuid, "incoming-reference");
});

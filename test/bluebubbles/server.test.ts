import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { io as socketClient, type Socket } from "socket.io-client";

import { BlueBubblesServer, derivePublicComputerId } from "../../src/bluebubbles/server.js";
import { BlueBubblesService } from "../../src/bluebubbles/service.js";
import { BlueBubblesStore } from "../../src/bluebubbles/store.js";
import { ICloudShareResolver } from "../../src/bluebubbles/icloud-share.js";
import type {
  FaceTimeIncomingSession,
  FaceTimeNativeMediaStreamStatus,
  FocusPeersSyncPage,
  FreshICloudPhotoShare,
  IMessageEngine,
} from "../../src/native/engine.js";
import type {
  FaceTimeCall,
  FaceTimeLiveVideoTranscoderController,
  FaceTimeLiveVideoTranscoderOptions,
} from "../../src/bluebubbles/facetime-media.js";
import { SessionStore } from "../../src/profile.js";
import type {
  EngineSnapshot,
  IdsLookupResult,
  InitializeParams,
  NativeFindMyFollow,
  SendAttachmentParams,
  SendComponentParams,
  SendConversationBackgroundParams,
  SendEditParams,
  SendGroupIconParams,
  SendGroupLeaveParams,
  SendGroupParticipantsParams,
  SendGroupRenameParams,
  SendMessageParams,
  SendMarkUnreadParams,
  SendMultipartMessageParams,
  SendNotifyParams,
  SendReadReceiptParams,
  SendReactionParams,
  SendStickerReactionParams,
  UpdateStickerReactionParams,
  SendPollVoteParams,
  SendTypingParams,
  SendUnsendParams,
  ValidateHandlesParams,
} from "../../src/types.js";
import {
  PINNED_BLUEBUBBLES_REST_ROUTES,
  PINNED_BLUEBUBBLES_SOCKET_EVENTS,
} from "../fixtures/bluebubbles-rest-routes.js";

const snapshot: EngineSnapshot = {
  protocolVersion: "1",
  deviceId: "device-test",
  apsState: "aps",
  users: "users",
  identity: "identity",
  accountUsername: "secondary@example.com",
  credentialBackend: "macos-keychain",
  idsMode: "normal",
  handles: ["mailto:secondary@example.com"],
  clientStarted: true,
  secondsSinceLastInbound: 1,
};

test("BlueBubbles public computer IDs are stable, profile-scoped, and opaque", () => {
  const first = derivePublicComputerId("secondary", "hardware-uuid");
  assert.equal(first, derivePublicComputerId("secondary", "hardware-uuid"));
  assert.notEqual(first, derivePublicComputerId("another-profile", "hardware-uuid"));
  assert.notEqual(first, "hardware-uuid");
  assert.match(first, /^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
});

class FakeEngine extends EventEmitter implements IMessageEngine {
  currentSnapshot: EngineSnapshot = { ...snapshot, handles: [...snapshot.handles] };
  readonly messages: SendMessageParams[] = [];
  readonly components: SendComponentParams[] = [];
  readonly backgrounds: SendConversationBackgroundParams[] = [];
  readonly focusSubscriptions: string[][] = [];
  readonly reactions: SendReactionParams[] = [];
  readonly stickerReactions: Array<{ params: SendStickerReactionParams; data: Buffer }> = [];
  readonly stickerUpdates: UpdateStickerReactionParams[] = [];
  readonly pollVotes: SendPollVoteParams[] = [];
  readonly attachments: Array<{ params: SendAttachmentParams; data: Buffer }> = [];
  readonly multiparts: Array<{ params: SendMultipartMessageParams; data: Buffer[] }> = [];
  readonly groupRenames: SendGroupRenameParams[] = [];
  readonly groupParticipants: SendGroupParticipantsParams[] = [];
  readonly groupLeaves: SendGroupLeaveParams[] = [];
  readonly groupIcons: Array<{ params: SendGroupIconParams; data?: Buffer }> = [];
  readonly typing: SendTypingParams[] = [];
  readonly reads: SendReadReceiptParams[] = [];
  readonly unreads: SendMarkUnreadParams[] = [];
  readonly unsends: SendUnsendParams[] = [];
  readonly notifications: SendNotifyParams[] = [];
  readonly validations: ValidateHandlesParams[] = [];
  readonly findMyRequests: Array<string | undefined> = [];
  readonly freshICloudShares: Array<{
    path: string;
    filename: string;
    mimeType: string;
    title?: string;
    data: Buffer;
  }> = [];

  initialize(_params: InitializeParams): Promise<EngineSnapshot> {
    return Promise.resolve(this.currentSnapshot);
  }
  loginStart(_appleId: string, _password: string): Promise<{ needs2fa: boolean }> {
    return Promise.resolve({ needs2fa: false });
  }
  login2faOptions(): Promise<{ phones: [] }> {
    return Promise.resolve({ phones: [] });
  }
  loginRequestSms(_phoneId: number): Promise<{ sent: boolean }> {
    return Promise.resolve({ sent: true });
  }
  loginSubmit2fa(_code: string): Promise<{ accepted: boolean }> {
    return Promise.resolve({ accepted: true });
  }
  loginFinish(): Promise<EngineSnapshot> {
    return Promise.resolve(this.currentSnapshot);
  }
  migrateCredentialToFile(_keyPath: string): Promise<{ migrated: boolean; credentialBackend: string }> {
    return Promise.resolve({ migrated: true, credentialBackend: "encrypted-file" });
  }
  startClient(): Promise<EngineSnapshot> {
    return Promise.resolve(this.currentSnapshot);
  }
  snapshot(): Promise<EngineSnapshot> {
    return Promise.resolve(this.currentSnapshot);
  }
  health(): Promise<{ clientStarted: boolean; secondsSinceLastInbound: number }> {
    return Promise.resolve({ clientStarted: true, secondsSinceLastInbound: 1 });
  }
  refreshFindMyFollowing(address?: string): Promise<NativeFindMyFollow[]> {
    this.findMyRequests.push(address);
    return Promise.resolve([{
      id: "findmy-follow-1",
      invitationAcceptedHandles: ["friend@example.com"],
      invitationFromHandles: ["secondary@example.com"],
      expires: 0,
      updateTimestamp: 4_300,
      isFromMessages: true,
      locateInProgress: false,
      lastLocation: {
        latitude: 37.335,
        longitude: -122.01,
        altitude: 12,
        horizontalAccuracy: 4,
        verticalAccuracy: 8,
        timestamp: 4_400,
        isInaccurate: false,
        isOld: false,
        formattedAddressLines: ["One Apple Park Way", "Cupertino, CA"],
        locality: "Cupertino",
        stateCode: "CA",
        countryCode: "US",
      },
    }]);
  }
  async createICloudPhotoShare(params: {
    path: string;
    filename: string;
    mimeType: string;
    title?: string;
  }): Promise<FreshICloudPhotoShare> {
    this.freshICloudShares.push({ ...params, data: await readFile(params.path) });
    return {
      url: "https://share.icloud.com/photos/05dFixtureShareToken_1234567890",
      shareId: "05dFixtureShareToken_1234567890",
      assetGuid: "fresh-asset-guid",
      itemCount: 1,
    };
  }
  sendMessage(params: SendMessageParams): Promise<{ guid: string }> {
    this.messages.push(params);
    return Promise.resolve({ guid: "sent-guid" });
  }
  sendComponent(params: SendComponentParams): Promise<{ guid: string }> {
    this.components.push(params);
    return Promise.resolve({ guid: "component-guid" });
  }
  setConversationBackground(params: SendConversationBackgroundParams): Promise<{ guid: string }> {
    this.backgrounds.push(params);
    return Promise.resolve({ guid: "background-guid" });
  }
  syncICloudContacts(): Promise<{ vcards: string[]; syncedAt: number }> {
    return Promise.resolve({
      syncedAt: 1234,
      vcards: ["BEGIN:VCARD\nVERSION:3.0\nFN:Cloud Friend\nEMAIL:cloud@example.com\nEND:VCARD"],
    });
  }
  subscribeFocus(handles: string[]): Promise<{ subscribed: string[] }> {
    this.focusSubscriptions.push(handles);
    return Promise.resolve({ subscribed: handles });
  }
  syncFocusPeers(cachedZone?: string, continuationToken?: string): Promise<FocusPeersSyncPage> {
    return Promise.resolve({
      resolvedZone: cachedZone ?? "0::com.apple.coredata.cloudkit.zone",
      ...(continuationToken ? {} : { continuationToken: "focus-next" }),
      done: Boolean(continuationToken),
      fetched: 1,
      inserted: 1,
      alreadyKnown: 0,
      decodeFailed: 0,
      recordsSeen: 2,
      injectedHandles: ["mailto:friend@example.com"],
      clusterObservations: [{ channelId: "focus-channel", senderHandle: "mailto:friend@example.com" }],
      discoverySummary: "fixture",
    });
  }
  shareFocus(): Promise<{ shared: boolean }> {
    return Promise.resolve({ shared: true });
  }
  syncCloudChats() {
    return Promise.resolve({ continuationToken: "chat-next", status: 2, done: false, chats: [] });
  }
  syncCloudMessages() {
    return Promise.resolve({ status: 3, done: true, messages: [] });
  }
  syncCloudAttachments() {
    return Promise.resolve({ status: 3, done: true, attachments: [] });
  }
  sendReaction(params: SendReactionParams): Promise<{ guid: string }> {
    this.reactions.push(params);
    return Promise.resolve({ guid: "reaction-guid" });
  }
  async sendStickerReaction(params: SendStickerReactionParams): Promise<{ guid: string }> {
    this.stickerReactions.push({ params, data: await readFile(params.path) });
    return { guid: "sticker-reaction-guid" };
  }
  updateStickerReaction(params: UpdateStickerReactionParams): Promise<{ guid: string }> {
    this.stickerUpdates.push(params);
    return Promise.resolve({ guid: "sticker-update-guid" });
  }
  sendPollVote(params: SendPollVoteParams): Promise<{ guid: string }> {
    this.pollVotes.push(params);
    return Promise.resolve({ guid: "poll-vote-guid" });
  }
  async sendAttachment(params: SendAttachmentParams): Promise<{ guid: string }> {
    this.attachments.push({ params, data: await readFile(params.path) });
    return Promise.resolve({ guid: "attachment-message-guid" });
  }
  async sendMultipartMessage(params: SendMultipartMessageParams): Promise<{ guid: string }> {
    const data = await Promise.all(params.parts.flatMap((part) =>
      part.path ? [readFile(part.path)] : [],
    ));
    this.multiparts.push({ params, data });
    return { guid: "multipart-message-guid" };
  }
  renameGroup(params: SendGroupRenameParams): Promise<{ guid: string }> {
    this.groupRenames.push(params);
    return Promise.resolve({ guid: `group-rename-${this.groupRenames.length}` });
  }
  changeGroupParticipants(params: SendGroupParticipantsParams): Promise<{ guid: string }> {
    this.groupParticipants.push(params);
    return Promise.resolve({ guid: `group-participants-${this.groupParticipants.length}` });
  }
  leaveGroup(params: SendGroupLeaveParams): Promise<{ guid: string }> {
    this.groupLeaves.push(params);
    return Promise.resolve({ guid: `group-leave-${this.groupLeaves.length}` });
  }
  async setGroupIcon(params: SendGroupIconParams): Promise<{ guid: string }> {
    this.groupIcons.push({ params, ...(params.path ? { data: await readFile(params.path) } : {}) });
    return { guid: `group-icon-${this.groupIcons.length}` };
  }
  validateHandles(params: ValidateHandlesParams): Promise<{ available: string[] }> {
    this.validations.push(params);
    return Promise.resolve({ available: params.addresses.filter((address) => address.includes("friend")) });
  }
  lookupHandles(params: ValidateHandlesParams): Promise<IdsLookupResult> {
    const available = params.addresses.filter((address) => address.includes("friend"));
    return Promise.resolve({
      available,
      targets: params.addresses.map((address) => ({
        address,
        cacheEntryFresh: true,
        responseEntryReturned: true,
        identityCount: available.includes(address) ? 1 : 0,
        correlationIdentifierPresent: false,
      })),
      error: null,
      panicked: false,
      timedOut: false,
      attempts: 1,
    });
  }
  validateHandlesHttp(params: ValidateHandlesParams): Promise<{ available: string[] }> {
    return this.validateHandles(params);
  }
  sendEdit(_params: SendEditParams): Promise<{ guid: string }> {
    return Promise.resolve({ guid: "edit-guid" });
  }
  sendUnsend(params: SendUnsendParams): Promise<{ guid: string }> {
    this.unsends.push(params);
    return Promise.resolve({ guid: "unsend-guid" });
  }
  sendTyping(params: SendTypingParams): Promise<{ sent: boolean }> {
    this.typing.push(params);
    return Promise.resolve({ sent: true });
  }
  sendReadReceipt(params: SendReadReceiptParams): Promise<{ sent: boolean }> {
    this.reads.push(params);
    return Promise.resolve({ sent: true });
  }
  sendMarkUnread(params: SendMarkUnreadParams): Promise<{ sent: boolean }> {
    this.unreads.push(params);
    return Promise.resolve({ sent: true });
  }
  sendNotify(params: SendNotifyParams): Promise<{ guid: string }> {
    this.notifications.push(params);
    return Promise.resolve({ guid: "notify-guid" });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class NativeStreamTestService extends BlueBubblesService {
  readonly streamPolicies: Array<{
    sessionId: string;
    enabled: boolean;
    audio?: boolean;
    video?: boolean;
    ttlSeconds?: number;
  }> = [];

  override get nativeFaceTimeMediaAvailable(): boolean {
    return true;
  }

  override get nativeFaceTimeStreamingAvailable(): boolean {
    return true;
  }

  override get nativeFaceTimeLiveAudioAvailable(): boolean {
    return true;
  }

  override setNativeFaceTimeMediaStream(params: {
    sessionId: string;
    enabled: boolean;
    audio?: boolean;
    video?: boolean;
    ttlSeconds?: number;
  }): Promise<FaceTimeNativeMediaStreamStatus> {
    this.streamPolicies.push({ ...params });
    return Promise.resolve({
      sessionId: params.sessionId,
      enabled: params.enabled,
      audio: params.audio ?? false,
      video: params.video ?? false,
      expiresAt: params.enabled ? Date.now() + (params.ttlSeconds ?? 300) * 1_000 : null,
    });
  }
}

class IncomingFaceTimeTestService extends NativeStreamTestService {
  readonly liveAudioFrames: Buffer[] = [];
  readonly liveAudioPresentationTimes: Array<number | undefined> = [];
  readonly liveVideoFrames: Buffer[] = [];
  readonly liveVideoPresentationTimes: Array<number | undefined> = [];
  readonly liveVideoStarts: Array<{
    sessionId: string;
    imageDescription: Buffer;
    frameDurationMs?: number;
    mediaEpochUnixMs?: number;
    rtpTimestampBase?: number;
  }> = [];
  readonly incoming: FaceTimeIncomingSession[] = [{
    sessionId: "INCOMING-SESSION-1",
    state: "ringing",
    mode: "video",
    caller: "tel:+12025550142",
    participants: ["tel:+12025550142"],
    myHandles: ["mailto:secondary@example.com"],
    startedAt: 1_234,
    nativeMediaAttached: false,
  }];

  override get nativeFaceTimeIncomingAvailable(): boolean {
    return true;
  }

  override get nativeFaceTimeLiveVideoAvailable(): boolean {
    return true;
  }

  override listIncomingFaceTimeSessions(): Promise<FaceTimeIncomingSession[]> {
    return Promise.resolve(structuredClone(this.incoming));
  }

  override answerIncomingFaceTimeSession(
    params: { sessionId: string },
  ): Promise<FaceTimeIncomingSession> {
    const session = this.incoming.find((value) => value.sessionId === params.sessionId);
    if (!session) throw new Error("not found");
    session.state = "active";
    session.nativeMediaAttached = true;
    return Promise.resolve(structuredClone(session));
  }

  override declineIncomingFaceTimeSession(sessionId: string): Promise<FaceTimeIncomingSession> {
    const session = this.incoming.find((value) => value.sessionId === sessionId);
    if (!session) throw new Error("not found");
    session.state = "declined";
    return Promise.resolve(structuredClone(session));
  }

  override startNativeFaceTimeLiveAudioStream(sessionId: string, timing?: {
    mediaEpochUnixMs?: number;
    rtpTimestampBase?: number;
  }) {
    return Promise.resolve({
      started: true,
      sessionId,
      frameBytes: 1_920 as const,
      queueCapacityFrames: 50,
      mediaEpochUnixMs: timing?.mediaEpochUnixMs ?? 1_000,
      rtpTimestampBase: timing?.rtpTimestampBase ?? 123,
    });
  }

  override pushNativeFaceTimeLiveAudioFrame(
    sessionId: string,
    frame: Buffer,
    presentationTimeUs?: number,
  ) {
    this.liveAudioFrames.push(Buffer.from(frame));
    this.liveAudioPresentationTimes.push(presentationTimeUs);
    return Promise.resolve({
      queued: true,
      sessionId,
      frameBytes: 1_920 as const,
      presentationTimeUs: presentationTimeUs ?? 0,
    });
  }

  override finishNativeFaceTimeLiveAudioStream(sessionId: string) {
    return Promise.resolve({ stopped: true, sessionId });
  }

  override startNativeFaceTimeLiveVideoStream(params: {
    sessionId: string;
    imageDescription: Buffer;
    frameDurationMs?: number;
    mediaEpochUnixMs?: number;
    rtpTimestampBase?: number;
  }) {
    this.liveVideoStarts.push({
      ...params,
      imageDescription: Buffer.from(params.imageDescription),
    });
    return Promise.resolve({
      started: true,
      sessionId: params.sessionId,
      encoding: "hevc-annex-b" as const,
      frameDurationMs: params.frameDurationMs ?? 40,
      queueCapacityFrames: 8,
      mediaEpochUnixMs: params.mediaEpochUnixMs ?? 1_000,
      rtpTimestampBase: params.rtpTimestampBase ?? 123,
    });
  }

  override pushNativeFaceTimeLiveVideoFrame(
    sessionId: string,
    frame: Buffer,
    presentationTimeUs?: number,
  ) {
    this.liveVideoFrames.push(Buffer.from(frame));
    this.liveVideoPresentationTimes.push(presentationTimeUs);
    return Promise.resolve({
      queued: true,
      sessionId,
      frameBytes: frame.length,
      presentationTimeUs: presentationTimeUs ?? 0,
    });
  }

  override finishNativeFaceTimeLiveVideoStream(sessionId: string) {
    return Promise.resolve({ stopped: true, sessionId });
  }
}

class PassiveFakeEngine extends FakeEngine {
  readonly passiveSnapshot: EngineSnapshot = { ...snapshot, idsMode: "passive" };

  override initialize(_params: InitializeParams): Promise<EngineSnapshot> {
    return Promise.resolve(this.passiveSnapshot);
  }

  override startClient(): Promise<EngineSnapshot> {
    return Promise.resolve(this.passiveSnapshot);
  }

  override snapshot(): Promise<EngineSnapshot> {
    return Promise.resolve(this.passiveSnapshot);
  }
}

class RacingReceiptFakeEngine extends FakeEngine {
  override sendMessage(params: SendMessageParams): Promise<{ guid: string }> {
    this.messages.push(params);
    // Model native stdout delivering controls before the JSON-RPC response
    // that gives TypeScript the outgoing GUID.
    this.emit("message.received", {
      uuid: "sent-guid",
      participants: [],
      timestampMs: 100,
      isSms: false,
      isStoredMessage: false,
      attachments: [],
      delivered: true,
    });
    this.emit("message.received", {
      uuid: "sent-guid",
      participants: [],
      timestampMs: 200,
      isSms: false,
      isStoredMessage: false,
      attachments: [],
      readReceipt: true,
    });
    return Promise.resolve({ guid: "sent-guid" });
  }
}

function serviceEvent(
  service: BlueBubblesService,
  type: string,
  timeoutMs = 2_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      service.off("event", listener);
      reject(new Error(`${type} event timed out`));
    }, timeoutMs);
    const listener = (event: { type: string; data: unknown }): void => {
      if (event.type !== type) return;
      clearTimeout(timer);
      service.off("event", listener);
      resolve(event.data);
    };
    service.on("event", listener);
  });
}

test("incoming FaceTime controls are authenticated, session-scoped, and media-aware", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-facetime-incoming-test-"));
  const engine = new FakeEngine();
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  const service = new IncomingFaceTimeTestService({
    profile: "test",
    password: "secret",
    engine,
    store,
    sessionStore: new SessionStore("test", join(root, "session.json")),
  });
  await service.start({
    version: 1,
    profile: "test",
    deviceId: "device-test",
    apsState: "aps",
    users: "users",
    identity: "identity",
    accountUsername: "secondary@example.com",
    handles: snapshot.handles,
    updatedAt: new Date().toISOString(),
  });

  const mediaAnswers: Array<{ sessionId: string; data: Buffer }> = [];
  let notifyMediaAnswer: (() => void) | undefined;
  const mediaManager = {
    list: (): FaceTimeCall[] => [],
    get: (): FaceTimeCall | undefined => undefined,
    start: async (): Promise<FaceTimeCall> => { throw new Error("not used"); },
    stop: async (): Promise<FaceTimeCall | undefined> => undefined,
    answerIncoming: async (input: {
      sessionId: string;
      displayName: string;
      sourcePath: string;
      maxDurationSeconds?: number;
    }): Promise<FaceTimeCall> => {
      mediaAnswers.push({ sessionId: input.sessionId, data: await readFile(input.sourcePath) });
      notifyMediaAnswer?.();
      const now = Date.now();
      return {
        id: "incoming-call-1",
        sessionId: input.sessionId,
        direction: "incoming",
        mode: "video",
        targets: ["tel:+12025550142"],
        displayName: input.displayName,
        state: "ringing",
        createdAt: now,
        updatedAt: now,
        maxDurationSeconds: input.maxDurationSeconds ?? 90,
        participantCount: 1,
        transport: "iblue-quickrelay",
        mediaSource: "uploaded",
      };
    },
    close: async (): Promise<void> => {},
  };
  const transcoderInputs: Buffer[] = [];
  const transcoderFactory = (
    options: FaceTimeLiveVideoTranscoderOptions,
  ): FaceTimeLiveVideoTranscoderController => {
    let started = false;
    let nativeStarted = false;
    return {
      inputFormat: options.inputFormat,
      get nativeStarted(): boolean { return nativeStarted; },
      start: async (): Promise<void> => { started = true; },
      push: async (data: Buffer, presentationTimeUs?: number): Promise<void> => {
        assert.equal(started, true);
        transcoderInputs.push(Buffer.from(data));
        if (!nativeStarted) {
          await options.onStart(Buffer.from("generated-hvc1-description"));
          nativeStarted = true;
        }
        await options.onFrame(
          Buffer.concat([Buffer.from("hevc:"), data]),
          presentationTimeUs ?? 0,
        );
      },
      finish: async (): Promise<void> => {},
      abort: async (): Promise<void> => {},
    };
  };
  const api = new BlueBubblesServer({
    service,
    port: 0,
    faceTimeMediaManager: mediaManager,
    faceTimeLiveVideoTranscoderFactory: transcoderFactory,
  });
  const listening = await api.start();
  const socket = socketClient(listening.address, {
    query: { password: "secret" },
    transports: ["websocket"],
  });
  const videoSocket = socketClient(listening.address, {
    query: { password: "secret" },
    transports: ["websocket"],
  });
  await Promise.all([socket, videoSocket].map((candidate) =>
    new Promise<void>((resolve, reject) => {
      candidate.once("connect", resolve);
      candidate.once("connect_error", reject);
    })));
  t.after(async () => {
    socket.disconnect();
    videoSocket.disconnect();
    await api.stop();
    await service.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const unauthorized = await fetch(`${listening.address}/api/v1/iblue/facetime/incoming`);
  assert.equal(unauthorized.status, 401);

  const listed = await fetch(
    `${listening.address}/api/v1/iblue/facetime/incoming?password=secret`,
  ).then((response) => response.json()) as { data: FaceTimeIncomingSession[] };
  assert.equal(listed.data[0]?.sessionId, "INCOMING-SESSION-1");
  assert.equal(listed.data[0]?.mode, "video");

  const answered = await fetch(
    `${listening.address}/api/v1/iblue/facetime/incoming/INCOMING-SESSION-1/answer?password=secret`,
    { method: "POST" },
  ).then((response) => response.json()) as { data: FaceTimeIncomingSession };
  assert.equal(answered.data.state, "active");
  assert.equal(answered.data.nativeMediaAttached, true);

  const liveAudioStarted = await socketAck<{ status: number }>(
    socket,
    "facetime-live-audio-start",
    {
      sessionId: "INCOMING-SESSION-1",
      mediaEpochUnixMs: 5_000,
      rtpTimestampBase: 456,
    },
  );
  assert.equal(liveAudioStarted.status, 200);
  const liveAudioFrame = await socketAck<{ status: number }>(
    socket,
    "facetime-live-audio-session-frame",
    {
      sessionId: "INCOMING-SESSION-1",
      data: Buffer.alloc(1_920, 1),
      presentationTimeUs: 1_000_000,
    },
  );
  assert.equal(liveAudioFrame.status, 200);
  assert.deepEqual(service.liveAudioFrames, [Buffer.alloc(1_920, 1)]);
  assert.deepEqual(service.liveAudioPresentationTimes, [1_000_000]);
  assert.equal((await socketAck<{ status: number }>(
    socket,
    "facetime-live-audio-session-frame",
    {
      sessionId: "INCOMING-SESSION-1",
      data: Buffer.alloc(1_920),
      presentationTimeUs: -1,
    },
  )).status, 400);

  const imageDescription = Buffer.from("hvc1-description");
  const liveVideoStarted = await socketAck<{ status: number }>(
    videoSocket,
    "facetime-live-video-start",
    {
      sessionId: "INCOMING-SESSION-1",
      imageDescription,
      frameDurationMs: 40,
      mediaEpochUnixMs: 5_000,
      rtpTimestampBase: 456,
    },
  );
  assert.equal(liveVideoStarted.status, 200);
  assert.deepEqual(service.liveVideoStarts, [{
    sessionId: "INCOMING-SESSION-1",
    imageDescription,
    frameDurationMs: 40,
    mediaEpochUnixMs: 5_000,
    rtpTimestampBase: 456,
  }]);
  const videoAccessUnit = Buffer.from([0, 0, 0, 1, 0x26, 1, 2, 3]);
  const liveVideoFrame = await socketAck<{ status: number }>(
    videoSocket,
    "facetime-live-video-frame",
    {
      sessionId: "INCOMING-SESSION-1",
      data: videoAccessUnit,
      presentationTimeUs: 1_000_000,
    },
  );
  assert.equal(liveVideoFrame.status, 200);
  assert.deepEqual(service.liveVideoFrames, [videoAccessUnit]);
  assert.deepEqual(service.liveVideoPresentationTimes, [1_000_000]);
  assert.equal((await socketAck<{ status: number }>(
    socket,
    "facetime-live-audio-session-finish",
    { sessionId: "INCOMING-SESSION-1" },
  )).status, 200);
  assert.equal((await socketAck<{ status: number }>(
    videoSocket,
    "facetime-live-video-finish",
    { sessionId: "INCOMING-SESSION-1" },
  )).status, 200);

  const transcodedVideoStarted = await socketAck<{
    status: number;
    data: { inputFormat: string; outputFormat: string; nativeStarted: boolean };
  }>(videoSocket, "facetime-live-video-start", {
    sessionId: "INCOMING-SESSION-1",
    inputFormat: "h264-annex-b",
    frameDurationMs: 40,
  });
  assert.equal(transcodedVideoStarted.status, 200);
  assert.deepEqual(transcodedVideoStarted.data, {
    sessionId: "INCOMING-SESSION-1",
    state: "encoder-ready",
    inputFormat: "h264-annex-b",
    outputFormat: "hevc-annex-b",
    outputWidth: 1_280,
    outputHeight: 720,
    resizeMode: "contain-black",
    nativeStarted: false,
  });
  const h264AccessUnit = Buffer.from([0, 0, 0, 1, 0x65, 4, 5, 6]);
  const transcodedFrame = await socketAck<{
    status: number;
    data: { nativeStarted: boolean };
  }>(videoSocket, "facetime-live-video-frame", {
    sessionId: "INCOMING-SESSION-1",
    data: h264AccessUnit,
    presentationTimeUs: 2_000_000,
  });
  assert.equal(transcodedFrame.status, 200);
  assert.equal(transcodedFrame.data.nativeStarted, true);
  assert.equal((transcodedFrame.data as { presentationTimeUs?: number }).presentationTimeUs, 2_000_000);
  assert.deepEqual(transcoderInputs, [h264AccessUnit]);
  assert.deepEqual(service.liveVideoStarts.at(-1), {
    sessionId: "INCOMING-SESSION-1",
    imageDescription: Buffer.from("generated-hvc1-description"),
    frameDurationMs: 40,
  });
  assert.deepEqual(service.liveVideoFrames.at(-1), Buffer.concat([
    Buffer.from("hevc:"),
    h264AccessUnit,
  ]));
  assert.equal(service.liveVideoPresentationTimes.at(-1), 2_000_000);
  assert.equal((await socketAck<{ status: number }>(
    videoSocket,
    "facetime-live-video-finish",
    { sessionId: "INCOMING-SESSION-1" },
  )).status, 200);

  const socketList = await socketAck<{ status: number; data: FaceTimeIncomingSession[] }>(
    socket,
    "facetime-incoming-list",
    {},
  );
  assert.equal(socketList.data[0]?.state, "active");
  const subscribed = await socketAck<{
    status: number;
    data: { subscriptionId: string; sessionId: string; audio: boolean; video: boolean };
  }>(socket, "facetime-media-subscribe", {
    sessionId: "INCOMING-SESSION-1",
    audio: true,
    video: true,
    ttlSeconds: 60,
  });
  assert.equal(subscribed.status, 200);
  assert.equal(subscribed.data.subscriptionId, "session:INCOMING-SESSION-1");
  assert.deepEqual(service.streamPolicies.at(-1), {
    sessionId: "INCOMING-SESSION-1",
    enabled: true,
    audio: true,
    video: true,
    ttlSeconds: 60,
  });
  const incomingFrame = new Promise<Record<string, unknown>>((resolve) =>
    socket.once("ft-media-frame", resolve));
  engine.emit("facetime.media.frame", {
    sessionId: "INCOMING-SESSION-1",
    kind: "audio",
    codec: "aac-eld",
    payloadType: 104,
    rtpTimestamp: 480,
    dataBase64: Buffer.from([4, 5, 6]).toString("base64"),
    receivedAt: Date.now(),
  });
  const frame = await incomingFrame;
  assert.equal(frame.callId, undefined);
  assert.equal(frame.subscriptionId, "session:INCOMING-SESSION-1");
  assert.deepEqual(Buffer.from(frame.data as Buffer), Buffer.from([4, 5, 6]));
  const unsubscribed = await socketAck<{ status: number; data: { removed: boolean } }>(
    socket,
    "facetime-media-unsubscribe",
    { sessionId: "INCOMING-SESSION-1" },
  );
  assert.equal(unsubscribed.data.removed, true);

  service.incoming[0]!.state = "ringing";
  service.incoming[0]!.nativeMediaAttached = false;
  const form = new FormData();
  form.append("media", new Blob([Buffer.from("video-fixture")], { type: "video/mp4" }), "fixture.mp4");
  form.append("displayName", "Jade");
  form.append("maxDurationSeconds", "45");
  const mediaAnswer = await fetch(
    `${listening.address}/api/v1/iblue/facetime/incoming/INCOMING-SESSION-1/answer-with-media?password=secret`,
    { method: "POST", body: form },
  ).then((response) => response.json()) as { data: FaceTimeCall };
  assert.equal(mediaAnswer.data.direction, "incoming");
  assert.equal(mediaAnswer.data.mode, "video");
  assert.equal(mediaAnswer.data.maxDurationSeconds, 45);
  assert.deepEqual(mediaAnswers, [{
    sessionId: "INCOMING-SESSION-1",
    data: Buffer.from("video-fixture"),
  }]);

  service.incoming[0]!.state = "ringing";
  const armForm = new FormData();
  armForm.append(
    "media",
    new Blob([Buffer.from("auto-answer-fixture")], { type: "video/mp4" }),
    "auto-answer.mp4",
  );
  armForm.append("caller", "+1 (202) 555-0142");
  armForm.append("displayName", "Primed Jade");
  armForm.append("maxDurationSeconds", "45");
  armForm.append("expiresInSeconds", "60");
  const armed = await fetch(
    `${listening.address}/api/v1/iblue/facetime/incoming/auto-answer?password=secret`,
    { method: "POST", body: armForm },
  ).then((response) => response.json()) as {
    data: { state: string; mode: string; caller: string; filename: string };
  };
  assert.equal(armed.data.state, "armed");
  assert.equal(armed.data.mode, "video");
  assert.equal(armed.data.caller, "tel:+12025550142");
  assert.equal(armed.data.filename, "auto-answer.mp4");
  const armStatus = await fetch(
    `${listening.address}/api/v1/iblue/facetime/incoming/auto-answer?password=secret`,
  ).then((response) => response.json()) as { data: { id: string; state: string } | null };
  assert.equal(armStatus.data?.state, "armed");

  const autoAnswered = new Promise<void>((resolve) => { notifyMediaAnswer = resolve; });
  service.dispatch("incoming-facetime", structuredClone(service.incoming[0]!));
  await autoAnswered;
  notifyMediaAnswer = undefined;
  assert.deepEqual(mediaAnswers.at(-1), {
    sessionId: "INCOMING-SESSION-1",
    data: Buffer.from("auto-answer-fixture"),
  });
  const consumedArm = await fetch(
    `${listening.address}/api/v1/iblue/facetime/incoming/auto-answer?password=secret`,
  ).then((response) => response.json()) as { data: unknown };
  assert.equal(consumedArm.data, null);

  service.incoming[0]!.state = "ringing";
  const declined = await fetch(
    `${listening.address}/api/v1/iblue/facetime/incoming/INCOMING-SESSION-1/decline?password=secret`,
    { method: "POST" },
  ).then((response) => response.json()) as { data: FaceTimeIncomingSession };
  assert.equal(declined.data.state, "declined");

  const capabilities = await fetch(
    `${listening.address}/api/v1/iblue/facetime/capabilities?password=secret`,
  ).then((response) => response.json()) as {
    data: {
      incomingCalls: {
        available: boolean;
        verification: string;
        topology: string;
        autoAnswer: string;
      };
    };
  };
  assert.equal(capabilities.data.incomingCalls.available, true);
  assert.equal(
    capabilities.data.incomingCalls.verification,
    "verified-audio-and-video-auto-answer-playback",
  );
  assert.equal(capabilities.data.incomingCalls.topology, "one-to-one");
  assert.equal(
    capabilities.data.incomingCalls.autoAnswer,
    "/api/v1/iblue/facetime/incoming/auto-answer",
  );
});

test("FaceTime realtime media is authenticated, opt-in, selective, and non-persistent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-facetime-realtime-test-"));
  const engine = new FakeEngine();
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  const service = new NativeStreamTestService({
    profile: "test",
    password: "secret",
    engine,
    store,
    sessionStore: new SessionStore("test", join(root, "session.json")),
  });
  await service.start({
    version: 1,
    profile: "test",
    deviceId: "device-test",
    apsState: "aps",
    users: "users",
    identity: "identity",
    accountUsername: "secondary@example.com",
    handles: snapshot.handles,
    updatedAt: new Date().toISOString(),
  });

  const call: FaceTimeCall = {
    id: "call-1",
    sessionId: "SESSION-1",
    direction: "outgoing",
    mode: "audio",
    targets: ["tel:+12025550142"],
    displayName: "Jade",
    state: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxDurationSeconds: 90,
    participantCount: 1,
    transport: "iblue-quickrelay",
  };
  const mediaManager = {
    list: (): FaceTimeCall[] => [structuredClone(call)],
    get: (id: string): FaceTimeCall | undefined => id === call.id ? structuredClone(call) : undefined,
    start: async (): Promise<FaceTimeCall> => structuredClone(call),
    stop: async (id: string): Promise<FaceTimeCall | undefined> => {
      if (id !== call.id) return undefined;
      call.state = "ended";
      call.endedAt = Date.now();
      call.updatedAt = call.endedAt;
      return structuredClone(call);
    },
    close: async (): Promise<void> => {},
  };
  const api = new BlueBubblesServer({ service, port: 0, faceTimeMediaManager: mediaManager });
  const listening = await api.start();
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await api.stop();
    await service.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const connect = async (): Promise<Socket> => {
    const socket = socketClient(listening.address, {
      query: { password: "secret" },
      transports: ["websocket"],
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    return socket;
  };
  const audioSocket = await connect();
  const videoSocket = await connect();

  let apiEvents = 0;
  service.on("event", () => { apiEvents += 1; });
  const audioSubscription = await socketAck<{ status: number; data: { audio: boolean; video: boolean } }>(
    audioSocket,
    "facetime-media-subscribe",
    { callId: call.id, audio: true, video: false, ttlSeconds: 60 },
  );
  assert.equal(audioSubscription.status, 200);
  assert.deepEqual(
    { audio: audioSubscription.data.audio, video: audioSubscription.data.video },
    { audio: true, video: false },
  );
  const videoSubscription = await socketAck<{ status: number }>(
    videoSocket,
    "facetime-media-subscribe",
    { callId: call.id, audio: false, video: true, ttlSeconds: 60 },
  );
  assert.equal(videoSubscription.status, 200);
  assert.deepEqual(
    service.streamPolicies.at(-1),
    { sessionId: call.sessionId, enabled: true, audio: true, video: true, ttlSeconds: 60 },
  );

  let videoSocketSawAudio = false;
  videoSocket.once("ft-media-frame", () => { videoSocketSawAudio = true; });
  const audioFramePromise = new Promise<Record<string, unknown>>((resolve) =>
    audioSocket.once("ft-media-frame", resolve));
  engine.emit("facetime.media.frame", {
    sessionId: call.sessionId,
    kind: "audio",
    codec: "evs",
    payloadType: 108,
    rtpTimestamp: 960,
    dataBase64: Buffer.from([1, 2, 3]).toString("base64"),
    receivedAt: Date.now(),
  });
  const audioFrame = await audioFramePromise;
  assert.deepEqual(Buffer.from(audioFrame.data as Buffer), Buffer.from([1, 2, 3]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(videoSocketSawAudio, false);

  let audioSocketSawVideo = false;
  audioSocket.once("ft-media-frame", () => { audioSocketSawVideo = true; });
  const videoFramePromise = new Promise<Record<string, unknown>>((resolve) =>
    videoSocket.once("ft-media-frame", resolve));
  engine.emit("facetime.media.frame", {
    sessionId: call.sessionId,
    kind: "video",
    codec: "h265",
    rtpTimestamp: 9_000,
    durationMs: 33,
    droppedPackets: 0,
    dataBase64: Buffer.from([0, 0, 0, 1, 0x26]).toString("base64"),
    receivedAt: Date.now(),
  });
  const videoFrame = await videoFramePromise;
  assert.deepEqual(Buffer.from(videoFrame.data as Buffer), Buffer.from([0, 0, 0, 1, 0x26]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(audioSocketSawVideo, false);
  assert.equal(apiEvents, 0, "raw FaceTime frames must not enter persisted/webhook API events");

  const audioUnsubscribe = await socketAck<{ status: number; data: { removed: boolean } }>(
    audioSocket,
    "facetime-media-unsubscribe",
    { callId: call.id },
  );
  assert.equal(audioUnsubscribe.data.removed, true);
  assert.deepEqual(
    service.streamPolicies.at(-1),
    { sessionId: call.sessionId, enabled: true, audio: false, video: true, ttlSeconds: 60 },
  );

  const stop = await socketAck<{ status: number; data: FaceTimeCall }>(
    audioSocket,
    "facetime-call-stop",
    { callId: call.id },
  );
  assert.equal(stop.status, 200);
  assert.equal(stop.data.state, "ended");
  assert.deepEqual(
    service.streamPolicies.at(-1),
    { sessionId: call.sessionId, enabled: false },
  );

  call.state = "active";
  delete call.endedAt;
  const resubscribe = await socketAck<{ status: number }>(
    videoSocket,
    "facetime-media-subscribe",
    { callId: call.id, ttlSeconds: 60 },
  );
  assert.equal(resubscribe.status, 200);
  videoSocket.disconnect();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.streamPolicies.at(-1)?.enabled === false) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(
    service.streamPolicies.at(-1),
    { sessionId: call.sessionId, enabled: false },
  );
});

test("FaceTime outbound live audio is socket-owned, exactly framed, bounded, and ephemeral", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-facetime-live-audio-test-"));
  const engine = new FakeEngine();
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  const service = new NativeStreamTestService({
    profile: "test",
    password: "secret",
    engine,
    store,
    sessionStore: new SessionStore("test", join(root, "session.json")),
  });
  await service.start({
    version: 1,
    profile: "test",
    deviceId: "device-test",
    apsState: "aps",
    users: "users",
    identity: "identity",
    accountUsername: "secondary@example.com",
    handles: snapshot.handles,
    updatedAt: new Date().toISOString(),
  });

  let sequence = 0;
  const calls = new Map<string, FaceTimeCall>();
  const frames: Array<{ callId: string; frame: Buffer }> = [];
  const finished: string[] = [];
  const mediaManager = {
    list: (): FaceTimeCall[] => [...calls.values()].map((call) => structuredClone(call)),
    get: (id: string): FaceTimeCall | undefined => {
      const call = calls.get(id);
      return call ? structuredClone(call) : undefined;
    },
    start: async (): Promise<FaceTimeCall> => { throw new Error("not used"); },
    stop: async (id: string): Promise<FaceTimeCall | undefined> => {
      const call = calls.get(id);
      if (!call) return undefined;
      call.state = "ended";
      call.endedAt = Date.now();
      return structuredClone(call);
    },
    startLiveAudio: async (input: {
      targets: string[];
      displayName: string;
      maxDurationSeconds?: number;
    }): Promise<FaceTimeCall> => {
      const now = Date.now();
      const call: FaceTimeCall = {
        id: `live-${++sequence}`,
        sessionId: `SESSION-LIVE-${sequence}`,
        direction: "outgoing",
        mode: "audio",
        targets: [...input.targets],
        displayName: input.displayName,
        state: "ringing",
        createdAt: now,
        updatedAt: now,
        maxDurationSeconds: input.maxDurationSeconds ?? 300,
        participantCount: 0,
        transport: "iblue-quickrelay",
        mediaSource: "live-stream",
        liveAudioFormat: {
          encoding: "pcm-f32le",
          sampleRate: 24_000,
          channels: 1,
          frameDurationMs: 20,
          frameBytes: 1_920,
        },
      };
      calls.set(call.id, call);
      return structuredClone(call);
    },
    pushLiveAudioFrame: async (callId: string, frame: Buffer): Promise<FaceTimeCall> => {
      const call = calls.get(callId);
      if (!call) throw new Error("not found");
      frames.push({ callId, frame: Buffer.from(frame) });
      return structuredClone(call);
    },
    finishLiveAudio: async (callId: string): Promise<FaceTimeCall | undefined> => {
      const call = calls.get(callId);
      if (!call) return undefined;
      finished.push(callId);
      call.state = "ended";
      call.endedAt = Date.now();
      call.updatedAt = call.endedAt;
      return structuredClone(call);
    },
    close: async (): Promise<void> => {},
  };
  const api = new BlueBubblesServer({ service, port: 0, faceTimeMediaManager: mediaManager });
  const listening = await api.start();
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await api.stop();
    await service.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const connect = async (): Promise<Socket> => {
    const socket = socketClient(listening.address, {
      query: { password: "secret" },
      transports: ["websocket"],
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    return socket;
  };
  const owner = await connect();
  const stranger = await connect();

  const metadataResponse = await fetch(
    `${listening.address}/api/v1/iblue/facetime/realtime?password=secret`,
  );
  const metadata = await metadataResponse.json() as {
    data: { outboundLiveMediaInjection: Record<string, unknown> };
  };
  assert.equal(metadata.data.outboundLiveMediaInjection.available, true);
  assert.equal(metadata.data.outboundLiveMediaInjection.queueCapacityFrames, 50);

  let apiEvents = 0;
  service.on("event", () => { apiEvents += 1; });
  const created = await socketAck<{ status: number; data: FaceTimeCall }>(
    owner,
    "facetime-live-audio-create",
    { address: "2025550142", displayName: "Jade", maxDurationSeconds: 45 },
  );
  assert.equal(created.status, 200);
  assert.deepEqual(created.data.targets, ["tel:+12025550142"]);
  assert.equal(created.data.mediaSource, "live-stream");
  assert.equal(created.data.maxDurationSeconds, 45);

  const denied = await socketAck<{ status: number }>(
    stranger,
    "facetime-live-audio-frame",
    { callId: created.data.id, data: Buffer.alloc(1_920) },
  );
  assert.equal(denied.status, 403);
  const malformed = await socketAck<{ status: number }>(
    owner,
    "facetime-live-audio-frame",
    { callId: created.data.id, data: Buffer.alloc(1_916) },
  );
  assert.equal(malformed.status, 400);

  const frame = Buffer.alloc(1_920, 0x5a);
  const accepted = await socketAck<{ status: number }>(
    owner,
    "facetime-live-audio-frame",
    { callId: created.data.id, data: frame },
  );
  assert.equal(accepted.status, 200);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.callId, created.data.id);
  assert.deepEqual(frames[0]!.frame, frame);
  assert.equal(apiEvents, 0, "outbound raw FaceTime frames must not enter API events or webhooks");

  const finishedByOwner = await socketAck<{ status: number; data: FaceTimeCall }>(
    owner,
    "facetime-live-audio-finish",
    { callId: created.data.id },
  );
  assert.equal(finishedByOwner.status, 200);
  assert.equal(finishedByOwner.data.state, "ended");

  const disconnectCall = await socketAck<{ status: number; data: FaceTimeCall }>(
    owner,
    "facetime-live-audio-create",
    { target: "mailto:kyle@example.com" },
  );
  assert.equal(disconnectCall.status, 200);
  owner.disconnect();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (finished.includes(disconnectCall.data.id)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(finished.includes(disconnectCall.data.id), "owner disconnect must finish its call");
});

function icloudShareFetchFixture(): typeof fetch {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith("/records/resolve")) {
      return new Response(JSON.stringify({
        results: [{
          zoneID: { zoneName: "CMM-ZONE", ownerRecordName: "_owner", zoneType: "REGULAR_CUSTOM_ZONE" },
          rootRecord: {
            fields: {
              assetCount: { value: 1, type: "INT64" },
              photosCount: { value: 1, type: "INT64" },
              videosCount: { value: 0, type: "INT64" },
              startDate: { value: 1_786_041_600_000, type: "TIMESTAMP" },
              endDate: { value: 1_786_041_600_000, type: "TIMESTAMP" },
            },
          },
          anonymousPublicAccess: {
            token: "fixture-token",
            databasePartition: "https://p126-ckdatabasews.icloud.com:443",
          },
        }],
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname.endsWith("/records/query")) {
      return new Response(JSON.stringify({
        records: [
          {
            recordName: "master-fixture",
            recordType: "CPLMaster",
            fields: {
              itemType: { value: "public.jpeg", type: "STRING" },
              resOriginalFileType: { value: "public.jpeg", type: "STRING" },
              resOriginalFileSize: { value: 10, type: "INT64" },
              resOriginalWidth: { value: 100, type: "INT64" },
              resOriginalHeight: { value: 50, type: "INT64" },
              resOriginalRes: {
                value: {
                  downloadURL: "https://cvws-h2.icloud-content.com/B/fixture/${f}",
                  size: 10,
                },
                type: "ASSETID",
              },
            },
          },
          {
            recordName: "asset-fixture",
            recordType: "CPLAsset",
            fields: {
              masterRef: { value: { recordName: "master-fixture" }, type: "REFERENCE" },
              assetDate: { value: 1_786_041_600_000, type: "TIMESTAMP" },
              duration: { value: 0, type: "INT64" },
            },
          },
        ],
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.hostname === "cvws-h2.icloud-content.com") {
      return new Response(Buffer.from("jpeg-bytes"), {
        headers: { "content-type": "image/jpeg", "content-length": "10" },
      });
    }
    throw new Error(`unexpected iCloud fixture URL ${url}`);
  };
}

test("iCloud Photos API resolves, downloads, and sends native share balloons", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-icloud-share-api-test-"));
  const engine = new FakeEngine();
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  const sessions = new SessionStore("test", join(root, "session.json"));
  const service = new BlueBubblesService({
    profile: "test",
    password: "secret",
    engine,
    store,
    sessionStore: sessions,
  });
  await service.start({
    version: 1,
    profile: "test",
    deviceId: "device-test",
    apsState: "aps",
    users: "users",
    identity: "identity",
    accountUsername: "secondary@example.com",
    handles: snapshot.handles,
    updatedAt: new Date().toISOString(),
  });
  const api = new BlueBubblesServer({
    service,
    port: 0,
    icloudShareResolver: new ICloudShareResolver(icloudShareFetchFixture()),
  });
  const listening = await api.start();
  t.after(async () => {
    await api.stop();
    await service.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const shareUrl = "https://share.icloud.com/photos/05dFixtureShareToken_1234567890";
  const incomingEvent = serviceEvent(service, "new-message");
  engine.emit("message.received", {
    uuid: "incoming-icloud-share-guid",
    sender: "mailto:friend@example.com",
    text: "\ufffd\ufffc",
    participants: ["mailto:friend@example.com"],
    timestampMs: 5_000,
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    appBalloon: {
      appName: "None",
      bundleId: "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.mobileslideshow.PhotosMessagesApp",
      url: shareUrl,
      isLive: true,
      caption: "Thursday",
      subcaption: "1 Photo",
      ldText: "Thursday - 1 Photo",
    },
  });
  await incomingEvent;

  const resolved = await fetch(
    `${listening.address}/api/v1/iblue/icloud-share/incoming-icloud-share-guid?password=secret`,
  );
  assert.equal(resolved.status, 200);
  const resolvedBody = await resolved.json() as {
    data: { itemCount: number; items: Array<{ guid: string; variants: { original: { downloadUrl: string } } }> };
  };
  assert.equal(resolvedBody.data.itemCount, 1);
  assert.equal(resolvedBody.data.items[0]?.guid, "asset-fixture");
  assert.equal(resolvedBody.data.items[0]?.variants.original.downloadUrl,
    "/api/v1/iblue/icloud-share/incoming-icloud-share-guid/item/asset-fixture/original");

  const downloaded = await fetch(
    `${listening.address}${resolvedBody.data.items[0]!.variants.original.downloadUrl}?password=secret`,
  );
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), Buffer.from("jpeg-bytes"));

  const sent = await fetch(`${listening.address}/api/v1/iblue/icloud-share?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatGuid: "iMessage;-;friend@example.com", url: shareUrl }),
  });
  assert.equal(sent.status, 200);
  const sentBody = await sent.json() as { data: { iBlue: { icloudShare: { itemCount: number } } } };
  assert.equal(sentBody.data.iBlue.icloudShare.itemCount, 1);
  assert.ok(engine.messages.at(-1)?.text.startsWith("\x00ICL\x01"));

  const form = new FormData();
  // Multipart field order is not semantic; media-first clients must work too.
  form.append("photo", new Blob([Buffer.from("fresh-jpeg-bytes")], { type: "image/jpeg" }), "fresh.jpg");
  form.append("chatGuid", "iMessage;-;friend@example.com");
  form.append("title", "Fresh test share");
  const created = await fetch(
    `${listening.address}/api/v1/iblue/icloud-share/create?password=secret`,
    { method: "POST", body: form },
  );
  assert.equal(created.status, 200);
  const createdBody = await created.json() as {
    data: {
      message: { guid: string };
      share: { url: string; shareId: string; assetGuid: string; itemCount: number };
    };
  };
  assert.equal(createdBody.data.message.guid, "sent-guid");
  assert.equal(createdBody.data.share.url, shareUrl);
  assert.equal(createdBody.data.share.shareId, "05dFixtureShareToken_1234567890");
  assert.equal(createdBody.data.share.assetGuid, "fresh-asset-guid");
  assert.equal(createdBody.data.share.itemCount, 1);
  assert.equal(engine.freshICloudShares.length, 1);
  assert.equal(engine.freshICloudShares[0]?.filename, "fresh.jpg");
  assert.equal(engine.freshICloudShares[0]?.mimeType, "image/jpeg");
  assert.equal(engine.freshICloudShares[0]?.title, "Fresh test share");
  assert.deepEqual(engine.freshICloudShares[0]?.data, Buffer.from("fresh-jpeg-bytes"));
  assert.ok(engine.messages.at(-1)?.text.startsWith("\x00ICL\x01"));

  const shareCountBeforeGif = engine.freshICloudShares.length;
  const gifForm = new FormData();
  gifForm.append("media", new Blob([Buffer.from("GIF89a fixture")], { type: "image/gif" }), "animated.gif");
  gifForm.append("chatGuid", "iMessage;-;friend@example.com");
  const rejectedGif = await fetch(
    `${listening.address}/api/v1/iblue/icloud-share/create?password=secret`,
    { method: "POST", body: gifForm },
  );
  assert.equal(rejectedGif.status, 415);
  const rejectedGifBody = await rejectedGif.json() as { status: number; message: string; error: { type: string } };
  assert.equal(rejectedGifBody.status, 415);
  assert.equal(rejectedGifBody.error.type, "Validation Error");
  assert.match(rejectedGifBody.message, /ordinary iMessage attachment API/);
  assert.equal(engine.freshICloudShares.length, shareCountBeforeGif);
});

test("iBlue cloud sync, components, contacts, Focus, and backgrounds use native capabilities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-protocol-extensions-test-"));
  const engine = new FakeEngine();
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  store.ensureDirectChat("iMessage;-;friend@example.com", {
    participants: ["mailto:friend@example.com"],
  });
  const service = new BlueBubblesService({
    profile: "test",
    password: "secret",
    engine,
    store,
    sessionStore: new SessionStore("test", join(root, "session.json")),
  });
  await service.start({
    version: 1,
    profile: "test",
    users: "users",
    identity: "identity",
    handles: snapshot.handles,
    updatedAt: new Date().toISOString(),
  });
  const api = new BlueBubblesServer({ service, port: 0 });
  const listening = await api.start();
  t.after(async () => {
    await api.stop();
    await service.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const componentResponse = await fetch(`${listening.address}/api/v1/iblue/message/component?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chatGuid: "iMessage;-;friend@example.com",
      bundleId: "com.example.MessagesExtension",
      appName: "Example",
      appId: 123456,
      url: "data:,fixture",
      caption: "Component title",
      isLive: true,
    }),
  });
  assert.equal(componentResponse.status, 200, await componentResponse.text());
  assert.equal(engine.components[0]?.caption, "Component title");
  assert.equal(engine.components[0]?.appId, 123456);
  assert.equal(store.getMessage("component-guid")?.iBlue?.component?.url, "data:,fixture");
  assert.equal(store.getMessage("component-guid")?.iBlue?.component?.appId, 123456);

  const backgroundResponse = await fetch(
    `${listening.address}/api/v1/iblue/chat/${encodeURIComponent("iMessage;-;friend@example.com")}/background?password=secret`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remove: true }),
    },
  );
  assert.equal(backgroundResponse.status, 200, await backgroundResponse.text());
  assert.equal(engine.backgrounds.length, 1);
  assert.equal(store.getConversationBackground("iMessage;-;friend@example.com")?.removed, true);

  const presetCatalogResponse = await fetch(
    `${listening.address}/api/v1/iblue/background/presets?password=secret`,
  );
  assert.equal(presetCatalogResponse.status, 200);
  const presetCatalog = await presetCatalogResponse.json() as {
    data: Array<{ identifier: string; family: string; animated: boolean }>;
  };
  assert.equal(presetCatalog.data.length, 12);
  assert.deepEqual(
    presetCatalog.data.find((background) => background.identifier === "clouds_4"),
    { identifier: "clouds_4", family: "sky", name: "Haze", animated: true },
  );

  const presetResponse = await fetch(
    `${listening.address}/api/v1/iblue/chat/${encodeURIComponent("iMessage;-;friend@example.com")}/background?password=secret`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "aurora_1" }),
    },
  );
  assert.equal(presetResponse.status, 200, await presetResponse.text());
  assert.equal(engine.backgrounds.at(-1)?.preset, "aurora_1");
  assert.deepEqual(store.getConversationBackground("iMessage;-;friend@example.com"), {
    removed: false,
    preset: "aurora_1",
    updatedAt: store.getConversationBackground("iMessage;-;friend@example.com")?.updatedAt,
  });

  const colorResponse = await fetch(
    `${listening.address}/api/v1/iblue/chat/${encodeURIComponent("iMessage;-;friend@example.com")}/background?password=secret`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "color", colors: ["#ff006f", "#ff0fffcc"] }),
    },
  );
  assert.equal(colorResponse.status, 200, await colorResponse.text());
  assert.equal(
    engine.backgrounds.at(-1)?.preset,
    "color:1.000000/0.000000/0.435294/1.000000//1.000000/0.058824/1.000000/0.800000",
  );
  assert.deepEqual(store.getConversationBackground("iMessage;-;friend@example.com")?.colors, [
    "#FF006FFF",
    "#FF0FFFCC",
  ]);

  const missingColorsResponse = await fetch(
    `${listening.address}/api/v1/iblue/chat/${encodeURIComponent("iMessage;-;friend@example.com")}/background?password=secret`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "color" }),
    },
  );
  assert.equal(missingColorsResponse.status, 400, await missingColorsResponse.text());

  const invalidPresetResponse = await fetch(
    `${listening.address}/api/v1/iblue/chat/${encodeURIComponent("iMessage;-;friend@example.com")}/background?password=secret`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "clouds_7" }),
    },
  );
  assert.equal(invalidPresetResponse.status, 400, await invalidPresetResponse.text());
  const backgroundEvent = serviceEvent(service, "iblue-conversation-background-changed");
  engine.emit("message.received", {
    uuid: "incoming-background-guid",
    sender: "mailto:friend@example.com",
    participants: ["mailto:friend@example.com"],
    timestampMs: 4_000,
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    conversationBackground: {
      remove: false,
      preset: "color",
      colors: ["#FF00B1FF", "#FF0FFEFF"],
      objectId: "background-object",
      url: "https://example.invalid/mmcs",
      fileSize: 456,
    },
  });
  await backgroundEvent;
  assert.equal(store.getConversationBackground("iMessage;-;friend@example.com")?.objectId, "background-object");
  assert.equal(store.getConversationBackground("iMessage;-;friend@example.com")?.preset, "color");
  assert.deepEqual(store.getConversationBackground("iMessage;-;friend@example.com")?.colors, [
    "#FF00B1FF",
    "#FF0FFEFF",
  ]);

  const contactsResponse = await fetch(`${listening.address}/api/v1/iblue/contact/icloud/sync?password=secret`, {
    method: "POST",
  });
  assert.equal(contactsResponse.status, 200, await contactsResponse.text());
  assert.equal(store.getContact("cloud@example.com")?.source, "icloud-carddav");

  const portrait = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const portraitForm = new FormData();
  portraitForm.append("attachment", new Blob([portrait], { type: "image/png" }), "mara.png");
  const portraitUpload = await fetch(`${listening.address}/api/v1/attachment/upload?password=secret`, {
    method: "POST",
    body: portraitForm,
  });
  const portraitUploadBody = await portraitUpload.json() as { data: { path: string } };
  assert.equal(portraitUpload.status, 200, JSON.stringify(portraitUploadBody));
  const contactCardResponse = await fetch(`${listening.address}/api/v1/iblue/contact-card?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chatGuid: "iMessage;-;friend@example.com",
      displayName: "Dr. Mara Voss",
      firstName: "Mara",
      lastName: "Voss",
      organization: "Orbital Garden Lab",
      title: "Greenhouse Systems Lead",
      phones: [{ value: "+1 202-555-0147", label: "cell", preferred: true }],
      emails: [{ value: "mara.voss@example.com", label: "work" }],
      photo: portraitUploadBody.data.path,
    }),
  });
  const contactCardBody = await contactCardResponse.json() as {
    data: {
      attachments: Array<{ guid: string; metadata: { iBlueContactCard?: boolean } }>;
      iBlue: { contactCards: Array<{ displayName: string; photo: { downloadUrl: string } }> };
    };
  };
  assert.equal(contactCardResponse.status, 200, JSON.stringify(contactCardBody));
  assert.equal(engine.attachments.at(-1)?.params.mimeType, "text/vcard");
  assert.equal(engine.attachments.at(-1)?.params.utiType, "public.vcard");
  assert.match(engine.attachments.at(-1)?.data.toString() ?? "", /FN:Dr\. Mara Voss/);
  assert.equal(contactCardBody.data.attachments[0]?.metadata.iBlueContactCard, true);
  assert.equal(contactCardBody.data.iBlue.contactCards[0]?.displayName, "Dr. Mara Voss");
  const contactPhotoResponse = await fetch(
    `${listening.address}${contactCardBody.data.iBlue.contactCards[0]!.photo.downloadUrl}&password=secret`,
  );
  assert.equal(contactPhotoResponse.status, 200);
  assert.equal(contactPhotoResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await contactPhotoResponse.arrayBuffer()), portrait);

  const focusUrl = `${listening.address}/api/v1/handle/${encodeURIComponent("friend@example.com")}/focus?password=secret`;
  assert.equal((await fetch(focusUrl)).status, 200);
  assert.deepEqual(engine.focusSubscriptions.at(-1), ["mailto:friend@example.com"]);
  engine.emit("focus.updated", {
    handle: "mailto:friend@example.com",
    available: false,
    mode: "com.apple.focus.mode.work",
    updatedAt: 5000,
  });
  const focus = await (await fetch(focusUrl)).json() as {
    data: { mode?: string; available: boolean; notificationsSilenced: boolean };
  };
  assert.equal(focus.data.mode, "com.apple.focus.mode.work");
  assert.equal(focus.data.available, false);
  assert.equal(focus.data.notificationsSilenced, true);
  assert.equal(store.getFocusStatus("friend@example.com")?.mode, "com.apple.focus.mode.work");

  const focusSyncResponse = await fetch(`${listening.address}/api/v1/iblue/focus/sync?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const focusSync = await focusSyncResponse.json() as {
    data: { inserted: number; continuationToken?: string; injectedHandles: string[] };
  };
  assert.equal(focusSyncResponse.status, 200, JSON.stringify(focusSync));
  assert.equal(focusSync.data.inserted, 1);
  assert.equal(focusSync.data.continuationToken, "focus-next");
  assert.deepEqual(focusSync.data.injectedHandles, ["mailto:friend@example.com"]);

  const cloudResponse = await fetch(
    `${listening.address}/api/v1/iblue/cloud/messages/chats/sync?password=secret`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  const cloudBody = await cloudResponse.json() as { data: { continuationToken?: string } };
  assert.equal(cloudResponse.status, 200, JSON.stringify(cloudBody));
  assert.equal(cloudBody.data.continuationToken, "chat-next");
});

test("passive IDS mode rejects BlueBubbles outbound traffic locally", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-passive-api-test-"));
  const engine = new PassiveFakeEngine();
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  const sessions = new SessionStore("test", join(root, "session.json"));
  const service = new BlueBubblesService({
    profile: "test",
    password: "secret",
    engine,
    store,
    sessionStore: sessions,
  });
  t.after(async () => {
    await service.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.start({
    version: 1,
    profile: "test",
    deviceId: "device-test",
    apsState: "aps",
    users: "users",
    identity: "identity",
    accountUsername: "secondary@example.com",
    handles: snapshot.handles,
    updatedAt: new Date().toISOString(),
  });

  await assert.rejects(
    service.isIMessageAvailable("friend@example.com"),
    /passive receive mode blocks attempts to query iMessage availability/,
  );
  await assert.rejects(
    service.sendText({ chatGuid: "iMessage;-;friend@example.com", message: "must stay local" }),
    /passive receive mode blocks attempts to send a message/,
  );
  await assert.rejects(
    service.leaveGroup("iMessage;+;group-guid"),
    /passive receive mode blocks attempts to leave a group/,
  );
  const scheduledFailure = serviceEvent(service, "scheduled-message-error");
  const scheduled = service.scheduler.create({
    payload: {
      chatGuid: "iMessage;-;friend@example.com",
      message: "scheduled traffic must also stay local",
      method: "private-api",
    },
    scheduledFor: new Date(Date.now() + 50).toISOString(),
    schedule: { type: "once" },
  });
  const failed = await scheduledFailure as { id: number; status: string; error: string };
  assert.equal(failed.id, scheduled.id);
  assert.equal(failed.status, "error");
  assert.match(failed.error, /passive receive mode blocks attempts to send a message/);
  assert.equal(engine.validations.length, 0);
  assert.equal(engine.messages.length, 0);
  assert.equal(engine.groupLeaves.length, 0);
});

test("IDS error envelopes update and emit the original outgoing BlueBubbles message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-send-error-event-test-"));
  const engine = new FakeEngine();
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  const sessions = new SessionStore("test", join(root, "session.json"));
  const service = new BlueBubblesService({
    profile: "test",
    password: "secret",
    engine,
    store,
    sessionStore: sessions,
  });
  t.after(async () => {
    await service.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.start({
    version: 1,
    profile: "test",
    deviceId: "device-test",
    apsState: "aps",
    users: "users",
    identity: "identity",
    accountUsername: "secondary@example.com",
    handles: snapshot.handles,
    updatedAt: new Date().toISOString(),
  });
  await service.sendText({
    chatGuid: "iMessage;-;friend@example.com",
    message: "will fail",
  });

  const errorEvent = serviceEvent(service, "message-send-error");
  engine.emit("message.received", {
    uuid: "error-envelope-guid",
    sender: "mailto:friend@example.com",
    participants: ["mailto:friend@example.com"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    error: { forUuid: "sent-guid", status: 47, message: "Not delivered" },
  });
  const failed = await errorEvent as { guid: string; error: number; isFromMe: boolean };
  assert.deepEqual(
    { guid: failed.guid, error: failed.error, isFromMe: failed.isFromMe },
    { guid: "sent-guid", error: 47, isFromMe: true },
  );
  assert.equal(store.getMessage("error-envelope-guid"), undefined);
  assert.equal(store.queryMessages({ chatGuid: "iMessage;-;friend@example.com" }).total, 1);
});

test("receipts racing the send response are published after the outgoing message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-racing-receipt-test-"));
  const engine = new RacingReceiptFakeEngine();
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  const sessions = new SessionStore("test", join(root, "session.json"));
  const service = new BlueBubblesService({
    profile: "test",
    password: "secret",
    engine,
    store,
    sessionStore: sessions,
  });
  t.after(async () => {
    await service.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.start({
    version: 1,
    profile: "test",
    deviceId: "device-test",
    apsState: "aps",
    users: "users",
    identity: "identity",
    accountUsername: "secondary@example.com",
    handles: snapshot.handles,
    updatedAt: new Date().toISOString(),
  });
  const events: Array<{ type: string; data: { guid?: string; messageGuid?: string } }> = [];
  service.on("event", (event) => events.push(event));

  const sent = await service.sendText({
    chatGuid: "iMessage;-;friend@example.com",
    message: "race-safe",
  });
  assert.equal(sent.guid, "sent-guid");
  assert.deepEqual(events.map(({ type }) => type), [
    "new-message",
    "updated-message",
    "iblue-message-receipt",
    "updated-message",
    "iblue-message-receipt",
  ]);
  assert.deepEqual(
    events.map(({ data }) => data.guid ?? data.messageGuid),
    ["sent-guid", "sent-guid", "sent-guid", "sent-guid", "sent-guid"],
  );
  assert.equal(store.getMessage("sent-guid")?.isDelivered, true);
  assert.equal(store.getMessage("sent-guid")?.dateDelivered, 100);
  assert.equal(store.getMessage("sent-guid")?.dateRead, 200);

  engine.emit("message.received", {
    uuid: "sent-guid",
    participants: [],
    timestampMs: 300,
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    readReceipt: true,
  });
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(events.length, 5, "duplicate receipt must not emit another event");
});

test("APNs replay emits each incoming message and typing envelope only once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-incoming-replay-test-"));
  const engine = new FakeEngine();
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  const sessions = new SessionStore("test", join(root, "session.json"));
  const service = new BlueBubblesService({
    profile: "test",
    password: "secret",
    engine,
    store,
    sessionStore: sessions,
  });
  t.after(async () => {
    await service.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.start({
    version: 1,
    profile: "test",
    deviceId: "device-test",
    apsState: "aps",
    users: "users",
    identity: "identity",
    accountUsername: "secondary@example.com",
    handles: snapshot.handles,
    updatedAt: new Date().toISOString(),
  });
  const events: string[] = [];
  service.on("event", ({ type }: { type: string }) => events.push(type));
  const incoming = {
    uuid: "replayed-message-guid",
    sender: "mailto:friend@example.com",
    text: "one webhook",
    participants: ["mailto:friend@example.com"],
    timestampMs: 100,
    isSms: false,
    isStoredMessage: true,
    attachments: [],
  };
  const typing = {
    uuid: "replayed-typing-guid",
    sender: "mailto:friend@example.com",
    participants: ["mailto:friend@example.com"],
    timestampMs: 101,
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    typing: { active: true },
  };
  engine.emit("message.received", incoming);
  engine.emit("message.received", incoming);
  engine.emit("message.received", typing);
  engine.emit("message.received", typing);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

  assert.deepEqual(events, ["typing-indicator", "new-message"]);
  assert.equal(store.queryMessages({ chatGuid: "iMessage;-;friend@example.com" }).total, 1);
});

test("standalone Name & Photo Sharing updates contacts without creating an empty message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-shared-profile-test-"));
  const engine = new FakeEngine();
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  const sessions = new SessionStore("test", join(root, "session.json"));
  const service = new BlueBubblesService({
    profile: "test",
    password: "secret",
    engine,
    store,
    sessionStore: sessions,
  });
  t.after(async () => {
    await service.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.start({
    version: 1,
    profile: "test",
    deviceId: "device-test",
    apsState: "aps",
    users: "users",
    identity: "identity",
    accountUsername: "secondary@example.com",
    handles: snapshot.handles,
    updatedAt: new Date().toISOString(),
  });

  const updatedContact = serviceEvent(service, "iblue-contact-updated");
  engine.emit("message.received", {
    uuid: "shared-profile-control-guid",
    sender: "mailto:friend@example.com",
    participants: ["mailto:friend@example.com"],
    timestampMs: 123,
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    sharedProfile: {
      displayName: "Jane Example",
      firstName: "Jane",
      lastName: "Example",
      hasPoster: false,
      avatarBase64: "AQID",
    },
  });
  assert.equal((await updatedContact as { displayName: string }).displayName, "Jane Example");
  assert.equal(store.countMessages(), 0);
  assert.equal(store.getContact("friend@example.com")?.source, "name-and-photo-sharing");
  assert.deepEqual(store.getContactAvatar("friend@example.com")?.data, Buffer.from([1, 2, 3]));
});

test("scheduled messages survive restart, execute, and reschedule recurring jobs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-scheduler-test-"));
  const databasePath = join(root, "test.sqlite");
  const attachmentRoot = join(root, "attachments");
  const seededStore = new BlueBubblesStore(databasePath, attachmentRoot);
  const seeded = seededStore.createScheduledMessage({
    payload: {
      chatGuid: "iMessage;-;friend@example.com",
      message: "survived restart",
      method: "private-api",
      subject: "durable subject",
      effectId: "com.apple.messages.effect.CKConfettiEffect",
    },
    scheduledFor: new Date(Date.now() + 500).toISOString(),
    schedule: { type: "once" },
  });
  seededStore.close();

  const engine = new FakeEngine();
  const store = new BlueBubblesStore(databasePath, attachmentRoot);
  const sessions = new SessionStore("test", join(root, "session.json"));
  const service = new BlueBubblesService({
    profile: "test",
    password: "secret",
    engine,
    store,
    sessionStore: sessions,
  });
  t.after(async () => {
    await service.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const sentAfterRestart = serviceEvent(service, "scheduled-message-sent");
  await service.start({
    version: 1,
    profile: "test",
    deviceId: "device-test",
    apsState: "aps",
    users: "users",
    identity: "identity",
    accountUsername: "secondary@example.com",
    handles: snapshot.handles,
    updatedAt: new Date().toISOString(),
  });
  const completed = await sentAfterRestart as { id: number; status: string; sentAt: string };
  assert.equal(completed.id, seeded.id);
  assert.equal(completed.status, "complete");
  assert.ok(Date.parse(completed.sentAt) > 0);
  assert.equal(engine.messages[0]?.text, "survived restart");
  assert.equal(engine.messages[0]?.subject, "durable subject");
  assert.equal(engine.messages[0]?.effectId, "com.apple.messages.effect.CKConfettiEffect");

  const recurringSent = serviceEvent(service, "scheduled-message-sent");
  const firstDue = Date.now() + 50;
  const recurring = service.scheduler.create({
    payload: {
      chatGuid: "iMessage;-;friend@example.com",
      message: "recurring",
      method: "apple-script",
    },
    scheduledFor: new Date(firstDue).toISOString(),
    schedule: { type: "recurring", interval: 1, intervalType: "hourly" },
  });
  const rescheduled = await recurringSent as { id: number; status: string; scheduledFor: string };
  assert.equal(rescheduled.id, recurring.id);
  assert.equal(rescheduled.status, "pending");
  assert.ok(Date.parse(rescheduled.scheduledFor) >= firstDue + 60 * 60 * 1000 - 1);
  assert.equal(engine.messages.at(-1)?.text, "recurring");
  assert.ok(service.scheduler.delete(recurring.id));
});

test("BlueBubbles REST auth, envelopes, message send, queries, and Socket.IO events", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-api-test-"));
  const engine = new FakeEngine();
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  const staleUpload = join(root, "attachments", ".uploads", "stale-upload");
  await mkdir(staleUpload, { recursive: true });
  await writeFile(join(staleUpload, "orphan.bin"), "orphan");
  const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(staleUpload, staleDate, staleDate);
  const sessions = new SessionStore("test", join(root, "session.json"));
  const service = new BlueBubblesService({
    profile: "test",
    password: "secret",
    engine,
    store,
    sessionStore: sessions,
    webhookRetryDelaysMs: [20, 40],
    webhookTimeoutMs: 500,
    webhookMaxAttempts: 4,
  });
  await service.start({
    version: 1,
    profile: "test",
    deviceId: "device-test",
    apsState: "aps",
    users: "users",
    identity: "identity",
    accountUsername: "secondary@example.com",
    handles: snapshot.handles,
    updatedAt: new Date().toISOString(),
  });
  const api = new BlueBubblesServer({ service, port: 0 });
  const listening = await api.start();
  t.after(async () => {
    await api.stop();
    await service.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const docs = await fetch(`${listening.address}/docs/`);
  const docsHtml = await docs.text();
  assert.equal(docs.status, 200, docsHtml);
  assert.match(docs.headers.get("content-type") ?? "", /text\/html/i);
  assert.match(docsHtml, /iBlue API Documentation|SwaggerUIBundle/);
  const swaggerBundle = await fetch(`${listening.address}/docs/static/swagger-ui-bundle.js`);
  assert.equal(swaggerBundle.status, 200);
  assert.match(swaggerBundle.headers.get("content-type") ?? "", /javascript/i);
  assert.ok((await swaggerBundle.arrayBuffer()).byteLength > 100_000);

  const openApiResponse = await fetch(`${listening.address}/openapi.json`);
  const openApiText = await openApiResponse.text();
  assert.equal(openApiResponse.status, 200, openApiText);
  const openApi = JSON.parse(openApiText) as {
    openapi: string;
    info: { title: string };
    security: Array<Record<string, unknown>>;
    components: {
      securitySchemes: Record<string, { type: string; in: string; name: string }>;
    };
    paths: Record<string, Record<string, {
      summary?: string;
      description?: string;
      operationId?: string;
      parameters?: Array<{
        name?: string;
        in?: string;
        description?: string;
        schema?: { description?: string };
      }>;
      requestBody?: { content?: Record<string, { schema?: Record<string, unknown> }> };
      responses?: Record<string, {
        content?: Record<string, { schema?: Record<string, unknown> }>;
      }>;
    }>>;
  };
  assert.equal(openApi.openapi, "3.1.0");
  assert.equal(openApi.info.title, "iBlue API");
  assert.deepEqual(openApi.security, [{ serverPassword: [] }]);
  assert.deepEqual(openApi.components.securitySchemes.serverPassword, {
    type: "apiKey",
    in: "query",
    name: "password",
    description: "The configured iBlue server password. BlueBubbles aliases `guid` and `token` are also accepted by the API.",
  });
  const documentedOperations = Object.entries(openApi.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem)
      .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
      .map(([method, operation]) => ({ path, method, operation })),
  );
  assert.equal(documentedOperations.length, 114);
  assert.ok(openApi.paths["/api/v1/iblue/facetime/realtime"]?.get);
  assert.ok(openApi.paths["/api/v1/iblue/facetime/incoming"]?.get);
  assert.ok(openApi.paths["/api/v1/iblue/facetime/incoming/auto-answer"]?.get);
  assert.ok(openApi.paths["/api/v1/iblue/facetime/incoming/auto-answer"]?.post);
  assert.ok(openApi.paths["/api/v1/iblue/facetime/incoming/auto-answer"]?.delete);
  assert.ok(openApi.paths["/api/v1/iblue/facetime/incoming/{sessionId}/answer"]?.post);
  assert.ok(openApi.paths["/api/v1/iblue/facetime/incoming/{sessionId}/answer-with-media"]?.post);
  assert.ok(openApi.paths["/api/v1/iblue/facetime/incoming/{sessionId}/decline"]?.post);
  const missingParameterDescriptions: string[] = [];
  const auditBodyProperties = (
    schema: Record<string, unknown> | undefined,
    label: string,
    prefix = "",
  ): void => {
    const properties = schema?.properties as Record<string, Record<string, unknown>> | undefined;
    for (const [name, property] of Object.entries(properties ?? {})) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (typeof property.description !== "string" || !property.description.trim()) {
        missingParameterDescriptions.push(`${label} body parameter ${path}`);
      }
      auditBodyProperties(property, label, path);
      if (property.items && typeof property.items === "object") {
        auditBodyProperties(property.items as Record<string, unknown>, label, `${path}[]`);
      }
    }
  };
  for (const { path, method, operation } of documentedOperations) {
    const label = `${method.toUpperCase()} ${path}`;
    assert.ok(operation.summary?.trim(), `${label} omitted a summary`);
    assert.ok(operation.description?.trim(), `${label} omitted a description`);
    assert.ok(operation.operationId?.trim(), `${label} omitted an operationId`);
    assert.doesNotMatch(String(operation.summary), /^(GET|POST|PUT|PATCH|DELETE) \/api\//, `${label} uses a placeholder summary`);
    for (const parameter of operation.parameters ?? []) {
      if (!parameter.description?.trim() && !parameter.schema?.description?.trim()) {
        missingParameterDescriptions.push(
          `${label} ${parameter.in ?? "unknown"} parameter ${parameter.name ?? "unknown"}`,
        );
      }
    }
    for (const media of Object.values(operation.requestBody?.content ?? {})) {
      auditBodyProperties(media.schema, label);
    }
  }
  assert.deepEqual(missingParameterDescriptions, [], "OpenAPI parameters omitted descriptions");
  assert.equal(openApi.paths["/api/v1/facetime/session"], undefined);
  assert.equal(openApi.paths["/api/v1/facetime/answer/{call_uuid}"], undefined);
  assert.equal(openApi.paths["/api/v1/facetime/leave/{call_uuid}"], undefined);
  assert.equal(openApi.paths["/api/v1/mac/lock"], undefined);
  const createShareDocs = openApi.paths["/api/v1/iblue/icloud-share/create"]?.post;
  assert.equal(createShareDocs?.summary, "Create and send a fresh iCloud Photos share");
  assert.match(String(createShareDocs?.description), /web importer rejects GIF/);
  assert.equal(
    openApi.paths["/api/v1/iblue/focus/sync"]?.post?.summary,
    "Recover Focus sharing keys from iCloud",
  );
  assert.equal(
    openApi.paths["/api/v1/iblue/contact-card"]?.post?.summary,
    "Create and send a contact card",
  );
  const receiptDocs = openApi.paths["/api/v1/iblue/message/{guid}/receipts"]?.get;
  assert.equal(receiptDocs?.summary, "List per-recipient delivery and read receipts");
  const receiptResponseSchema = receiptDocs?.responses?.["200"]?.content?.["application/json"]?.schema;
  assert.ok(receiptResponseSchema);
  const receiptDataSchema = (receiptResponseSchema.properties as Record<string, Record<string, unknown>>).data;
  assert.ok(receiptDataSchema);
  assert.equal(receiptDataSchema.type, "array");
  assert.deepEqual(
    (receiptDataSchema.items as { required: string[] }).required,
    ["id", "messageGuid", "chatGuid", "type", "source", "eventAt"],
  );
  const createShareSchema = createShareDocs?.requestBody?.content?.["multipart/form-data"]?.schema;
  assert.ok(createShareSchema);
  assert.deepEqual(createShareSchema.required, ["chatGuid", "media"]);
  assert.deepEqual(
    (createShareSchema.properties as Record<string, unknown>).media,
    { type: "string", format: "binary", description: "JPEG, PNG, HEIC/HEIF, QuickTime MOV, or MP4 media." },
  );

  const pluginOpenApiResponse = await fetch(`${listening.address}/docs/json`);
  assert.equal(pluginOpenApiResponse.status, 200);
  assert.equal((await pluginOpenApiResponse.json() as { info: { title: string } }).info.title, "iBlue API");

  await assert.rejects(stat(staleUpload));
  type TestWebhook = {
    type: string;
    data: {
      guid?: string;
      messageGuid?: string;
      type?: string;
      handle?: string;
      aliases?: string[];
      iBlue?: { senderVerificationFailed?: boolean };
    };
  };
  let resolveWebhook!: (value: TestWebhook) => void;
  const webhookDelivery = new Promise<TestWebhook>((resolve) => {
    resolveWebhook = resolve;
  });
  let resolveAliasWebhook!: (value: TestWebhook) => void;
  const aliasWebhookDelivery = new Promise<TestWebhook>((resolve) => {
    resolveAliasWebhook = resolve;
  });
  let resolveReceiptWebhook!: (value: TestWebhook) => void;
  const receiptWebhookDelivery = new Promise<TestWebhook>((resolve) => {
    resolveReceiptWebhook = resolve;
  });
  let retryWebhookAttempts = 0;
  const retryWebhookDeliveryIds: string[] = [];
  let resolveRetryWebhook!: (value: TestWebhook) => void;
  const retryWebhookDelivery = new Promise<TestWebhook>((resolve) => {
    resolveRetryWebhook = resolve;
  });
  const webhookReceiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as TestWebhook;
      if (request.url === "/retry") {
        retryWebhookAttempts += 1;
        retryWebhookDeliveryIds.push(String(request.headers["x-iblue-webhook-delivery-id"]));
        if (retryWebhookAttempts === 1) {
          response.writeHead(503).end();
          return;
        }
        resolveRetryWebhook(payload);
      } else if (request.url === "/receipt") {
        resolveReceiptWebhook(payload);
      } else if (payload.type === "imessage-aliases-removed") {
        resolveAliasWebhook(payload);
      } else {
        resolveWebhook(payload);
      }
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    webhookReceiver.once("error", reject);
    webhookReceiver.listen(0, "127.0.0.1", resolve);
  });
  const webhookPort = (webhookReceiver.address() as AddressInfo).port;
  let socket: Socket | undefined;
  t.after(async () => {
    socket?.disconnect();
    await new Promise<void>((resolve) => webhookReceiver.close(() => resolve()));
  });

  const unauthorized = await fetch(`${listening.address}/api/v1/ping`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json() as { status: number }).status, 401);

  const ping = await fetch(`${listening.address}/api/v1/ping?password=secret`);
  assert.deepEqual(await ping.json(), { status: 200, message: "Ping received!", data: "pong" });

  const info = await fetch(`${listening.address}/api/v1/server/info?password=secret`);
  const infoBody = await info.json() as {
    data: {
      computer_id: string;
      os_version: string;
      server_version: string;
      detected_imessage: string;
      macos_time_sync: number | null;
      local_ipv4s: string[];
      local_ipv6s: string[];
      iBlue: {
        idsMode: string;
        version: string;
        blueBubblesCompatibility: string;
        extensions: {
          messageFlair: string;
          polls: string;
          richLinks: string;
          icloudShares: string;
          icloudShareCreate: string;
          messageReceipts: string;
          messageReceiptEvent: string;
        };
      };
    };
  };
  assert.equal(infoBody.data.computer_id, derivePublicComputerId("test", "device-test"));
  assert.notEqual(infoBody.data.computer_id, snapshot.deviceId);
  assert.equal(infoBody.data.detected_imessage, "secondary@example.com");
  assert.equal(infoBody.data.macos_time_sync, null);
  assert.ok(Array.isArray(infoBody.data.local_ipv4s));
  assert.ok(Array.isArray(infoBody.data.local_ipv6s));
  assert.equal(infoBody.data.iBlue.idsMode, "normal");
  // Match the official BlueBubbles client's setup parser: it passes
  // server_version to Version.parse and directly indexes both major/minor OS
  // components. Branded or one-component strings break an otherwise healthy
  // connection before the first sync.
  assert.match(infoBody.data.server_version, /^\d+\.\d+\.\d+$/);
  const [osMajor, osMinor] = infoBody.data.os_version.split(".");
  assert.ok(Number.isInteger(Number(osMajor)));
  assert.ok(Number.isInteger(Number(osMinor)));
  assert.equal(infoBody.data.iBlue.version, "0.1.0");
  assert.equal(infoBody.data.iBlue.blueBubblesCompatibility, infoBody.data.server_version);
  assert.equal(infoBody.data.iBlue.extensions.messageFlair, "/api/v1/iblue/message/flair");
  assert.equal(infoBody.data.iBlue.extensions.polls, "/api/v1/iblue/poll/:messageGuid");
  assert.equal(infoBody.data.iBlue.extensions.richLinks, "message.iBlue.richLink");
  assert.equal(infoBody.data.iBlue.extensions.icloudShares, "/api/v1/iblue/icloud-share/:messageGuid");
  assert.equal(infoBody.data.iBlue.extensions.icloudShareCreate, "/api/v1/iblue/icloud-share/create");
  assert.equal(infoBody.data.iBlue.extensions.messageReceipts, "/api/v1/iblue/message/:guid/receipts");
  assert.equal(infoBody.data.iBlue.extensions.messageReceiptEvent, "iblue-message-receipt");

  const flairCatalog = await fetch(`${listening.address}/api/v1/iblue/message/flair?password=secret`);
  const flairCatalogBody = await flairCatalog.json() as {
    status: number;
    data: Array<{ name: string; category: string; effectId: string }>;
    metadata: { count: number };
  };
  assert.equal(flairCatalogBody.status, 200);
  assert.equal(flairCatalogBody.metadata.count, 13);
  assert.deepEqual(
    flairCatalogBody.data.find(({ name }) => name === "confetti"),
    {
      name: "confetti",
      displayName: "Confetti",
      category: "screen",
      effectId: "com.apple.messages.effect.CKConfettiEffect",
      known: true,
    },
  );

  // The official BlueBubbles client requests Firebase configuration during
  // both QR/manual setup paths, but treats this exact upstream 404 as a
  // connected server without push configuration. Socket.IO remains usable.
  const fcmClient = await fetch(`${listening.address}/api/v1/fcm/client?password=secret`);
  const fcmClientBody = await fcmClient.json() as { status: number; error: { message: string } };
  assert.equal(fcmClient.status, 404);
  assert.equal(fcmClientBody.status, 404);
  assert.equal(fcmClientBody.error.message, "Google Services file not found.");

  // Startup checks this asynchronously after setup. A valid negative result
  // avoids turning iBlue's independent release lifecycle into a client error.
  const updateCheck = await fetch(`${listening.address}/api/v1/server/update/check?password=secret`);
  assert.deepEqual(await updateCheck.json(), {
    status: 200,
    message: "Successfully checked for updates!",
    data: { available: false, metadata: {} },
  });
  const unsupportedUpdateInstall = await fetch(
    `${listening.address}/api/v1/server/update/install?password=secret`,
    { method: "POST" },
  );
  assert.equal(unsupportedUpdateInstall.status, 501);

  const invalidSchedule = await fetch(`${listening.address}/api/v1/message/schedule?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "send-message",
      payload: {
        chatGuid: "iMessage;-;friend@example.com",
        message: "too late",
        method: "private-api",
      },
      scheduledFor: Date.now() - 1,
      schedule: { type: "once" },
    }),
  });
  assert.equal(invalidSchedule.status, 400);

  const scheduleFor = Date.now() + 60 * 60 * 1000;
  const scheduledCreate = await fetch(`${listening.address}/api/v1/message/schedule?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "send-message",
      payload: {
        chatGuid: "iMessage;-;friend@example.com",
        message: "scheduled through the BB API",
        method: "private-api",
        subject: "later",
      },
      scheduledFor: scheduleFor,
      schedule: { type: "once" },
    }),
  });
  const scheduledCreateBody = await scheduledCreate.json() as {
    status: number;
    data: { id: number; scheduledFor: string; status: string; payload: { subject: string } };
  };
  assert.equal(scheduledCreate.status, 200);
  assert.equal(scheduledCreateBody.status, 200);
  assert.equal(scheduledCreateBody.data.status, "pending");
  assert.equal(Date.parse(scheduledCreateBody.data.scheduledFor), scheduleFor);
  assert.equal(scheduledCreateBody.data.payload.subject, "later");

  const scheduledList = await fetch(`${listening.address}/api/v1/message/schedule?password=secret`);
  const scheduledListBody = await scheduledList.json() as { data: Array<{ id: number }> };
  assert.ok(scheduledListBody.data.some((entry) => entry.id === scheduledCreateBody.data.id));
  const scheduledGet = await fetch(
    `${listening.address}/api/v1/message/schedule/${scheduledCreateBody.data.id}?password=secret`,
  );
  assert.equal((await scheduledGet.json() as { data: { id: number } }).data.id, scheduledCreateBody.data.id);

  const updatedScheduleFor = Date.now() + 2 * 60 * 60 * 1000;
  const scheduledUpdate = await fetch(
    `${listening.address}/api/v1/message/schedule/${scheduledCreateBody.data.id}?password=secret`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "send-message",
        payload: {
          chatGuid: "iMessage;-;friend@example.com",
          message: "updated scheduled message",
          method: "apple-script",
        },
        scheduledFor: updatedScheduleFor,
        schedule: { type: "recurring", interval: 2, intervalType: "weekly" },
      }),
    },
  );
  const scheduledUpdateBody = await scheduledUpdate.json() as {
    data: { status: string; schedule: { type: string; interval: number; intervalType: string } };
  };
  assert.equal(scheduledUpdate.status, 200);
  assert.equal(scheduledUpdateBody.data.status, "pending");
  assert.deepEqual(scheduledUpdateBody.data.schedule, {
    type: "recurring",
    interval: 2,
    intervalType: "weekly",
  });
  const scheduledDelete = await fetch(
    `${listening.address}/api/v1/message/schedule/${scheduledCreateBody.data.id}?password=secret`,
    { method: "DELETE" },
  );
  assert.equal(scheduledDelete.status, 200);
  const deletedSchedule = await fetch(
    `${listening.address}/api/v1/message/schedule/${scheduledCreateBody.data.id}?password=secret`,
  );
  assert.equal((await deletedSchedule.json() as { data: unknown }).data, null);

  const unsupportedAdmin = await fetch(`${listening.address}/api/v1/server/logs?password=secret`);
  const unsupportedAdminBody = await unsupportedAdmin.json() as {
    status: number;
    error: { type: string; message: string };
  };
  assert.equal(unsupportedAdmin.status, 501);
  assert.equal(unsupportedAdminBody.status, 501);
  assert.equal(unsupportedAdminBody.error.type, "Not Implemented");
  assert.equal(unsupportedAdminBody.error.message, "UNSUPPORTED_BY_DIRECT_IDS");

  const sent = await fetch(`${listening.address}/api/v1/message/text?token=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chatGuid: "iMessage;-;friend@example.com",
      message: "hello",
      tempGuid: "temp-guid",
      selectedMessageGuid: "reply-target-guid",
      subject: "subject line",
      effectId: "com.apple.messages.effect.CKConfettiEffect",
      method: "private-api",
    }),
  });
  const sentBody = await sent.json() as {
    status: number;
    data: { guid: string; tempGuid: string; threadOriginatorGuid: string; threadOriginatorPart: string };
  };
  assert.equal(sentBody.status, 200);
  assert.equal(sentBody.data.guid, "sent-guid");
  assert.equal(sentBody.data.tempGuid, "temp-guid");
  assert.equal(sentBody.data.threadOriginatorGuid, "reply-target-guid");
  assert.equal(sentBody.data.threadOriginatorPart, "0");
  assert.equal(engine.messages.at(-1)?.replyGuid, "reply-target-guid");
  assert.equal(engine.messages.at(-1)?.replyPart, "0");
  assert.equal(engine.messages.at(-1)?.subject, "subject line");
  assert.equal(engine.messages.at(-1)?.effectId, "com.apple.messages.effect.CKConfettiEffect");
  assert.equal(sentBody.data.threadOriginatorGuid, "reply-target-guid");

  const flairSent = await fetch(`${listening.address}/api/v1/message/text?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chatGuid: "iMessage;-;friend@example.com",
      message: "friendly flair",
      flair: "confetti",
    }),
  });
  assert.equal(flairSent.status, 200);
  assert.equal(engine.messages.at(-1)?.effectId, "com.apple.messages.effect.CKConfettiEffect");

  const textEffectCatalog = await fetch(
    `${listening.address}/api/v1/iblue/message/text-effects?password=secret`,
  );
  const textEffectCatalogBody = await textEffectCatalog.json() as {
    data: { styles: string[]; effects: string[]; rangeEncoding: string };
  };
  assert.deepEqual(textEffectCatalogBody.data.styles, ["bold", "italic", "underline", "strikethrough"]);
  assert.equal(textEffectCatalogBody.data.effects.length, 8);
  assert.equal(textEffectCatalogBody.data.rangeEncoding, "utf-16");

  const attributedSent = await fetch(`${listening.address}/api/v1/message/text?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chatGuid: "iMessage;-;friend@example.com",
      message: "Bold Big",
      textRuns: [
        { range: [0, 4], styles: ["bold"] },
        { range: [5, 3], effect: "big" },
      ],
    }),
  });
  assert.equal(attributedSent.status, 200);
  assert.equal(
    engine.messages.at(-1)?.html,
    "<strong>Bold</strong> <span data-mx-imessage-effect=\"big\">Big</span>",
  );

  const emojiReacted = await fetch(`${listening.address}/api/v1/message/react?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chatGuid: "iMessage;-;friend@example.com",
      selectedMessageGuid: "sent-guid",
      reaction: "emoji",
      emoji: "🚙",
    }),
  });
  assert.equal(emojiReacted.status, 200);
  assert.equal(engine.reactions.at(-1)?.reaction, "emoji");
  assert.equal(engine.reactions.at(-1)?.emoji, "🚙");

  const invalidEmoji = await fetch(`${listening.address}/api/v1/message/react?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chatGuid: "iMessage;-;friend@example.com",
      selectedMessageGuid: "sent-guid",
      reaction: "emoji",
      emoji: "not emoji",
    }),
  });
  assert.equal(invalidEmoji.status, 400);

  const stickerForm = new FormData();
  stickerForm.append("chatGuid", "iMessage;-;friend@example.com");
  stickerForm.append("selectedMessageGuid", "sent-guid");
  stickerForm.append("source", "genmoji");
  stickerForm.append("sticker", new Blob([Buffer.from([1, 2, 3])], { type: "image/png" }), "fixture.png");
  const stickerReacted = await fetch(
    `${listening.address}/api/v1/iblue/message/sticker?password=secret`,
    { method: "POST", body: stickerForm },
  );
  const stickerReactedBody = await stickerReacted.json() as {
    data: { attachments: Array<{ isSticker?: boolean }>; iBlue?: { reaction?: { stickerSource?: string } } };
  };
  assert.equal(stickerReacted.status, 200);
  assert.equal(engine.stickerReactions.at(-1)?.params.source, "genmoji");
  assert.deepEqual(engine.stickerReactions.at(-1)?.data, Buffer.from([1, 2, 3]));
  assert.equal(stickerReactedBody.data.attachments[0]?.isSticker, true);
  assert.equal(stickerReactedBody.data.iBlue?.reaction?.stickerSource, "genmoji");

  const stickerUpdated = await fetch(
    `${listening.address}/api/v1/iblue/message/sticker/update?password=secret`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatGuid: "iMessage;-;friend@example.com",
        messageGuid: "sticker-reaction-guid",
        scale: 0.5,
      }),
    },
  );
  assert.equal(stickerUpdated.status, 200);
  assert.equal(engine.stickerUpdates.at(-1)?.targetUuid, "sticker-reaction-guid");
  assert.equal(engine.stickerUpdates.at(-1)?.scale, 0.5);
  assert.equal(engine.stickerUpdates.at(-1)?.stickerId, "fixture.png");
  assert.match(engine.stickerUpdates.at(-1)?.hash ?? "", /^[0-9a-f]{32}$/);

  const invalidStickerScale = await fetch(
    `${listening.address}/api/v1/iblue/message/sticker/update?password=secret`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatGuid: "iMessage;-;friend@example.com",
        messageGuid: "sticker-reaction-guid",
        scale: 0,
      }),
    },
  );
  assert.equal(invalidStickerScale.status, 400);

  const stickerUnsend = await fetch(
    `${listening.address}/api/v1/message/sticker-reaction-guid/unsend?password=secret`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  const stickerUnsendBody = await stickerUnsend.json() as { error: { message: string } };
  assert.equal(stickerUnsend.status, 400);
  assert.equal(stickerUnsendBody.error.message, "STICKER_UNSEND_UNSUPPORTED");
  assert.equal(engine.unsends.length, 0);

  const unknownFlair = await fetch(`${listening.address}/api/v1/message/text?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chatGuid: "iMessage;-;friend@example.com",
      message: "invalid flair",
      flair: "party-parrot",
    }),
  });
  assert.equal(unknownFlair.status, 400);
  assert.match(
    (await unknownFlair.json() as { message: string }).message,
    /Unknown message flair/,
  );

  const deliveredAt = Date.now() + 1_000;
  const deliveryReceiptEvent = serviceEvent(service, "iblue-message-receipt");
  const deliveryEvent = new Promise<{ type: string; data: {
    guid: string; isDelivered: boolean; dateDelivered: number; subject: string;
    expressiveSendStyleId: string; iBlue?: { senderVerificationFailed?: boolean };
  } }>((resolve) => service.once("event", resolve));
  engine.emit("message.received", {
    uuid: "sent-guid",
    sender: "mailto:friend@example.com",
    participants: ["mailto:friend@example.com"],
    timestampMs: deliveredAt,
    isSms: false,
    isStoredMessage: false,
    verificationFailed: false,
    attachments: [],
    delivered: true,
  });
  const deliveredUpdate = await deliveryEvent;
  assert.equal(deliveredUpdate.type, "updated-message");
  assert.equal(deliveredUpdate.data.guid, "sent-guid");
  assert.equal(deliveredUpdate.data.isDelivered, true);
  assert.equal(deliveredUpdate.data.dateDelivered, deliveredAt);
  assert.equal(deliveredUpdate.data.subject, "subject line");
  assert.equal(deliveredUpdate.data.expressiveSendStyleId, "com.apple.messages.effect.CKConfettiEffect");
  assert.equal(deliveredUpdate.data.iBlue?.senderVerificationFailed, false);
  const deliveryReceipt = await deliveryReceiptEvent as {
    messageGuid: string; type: string; handle?: string; eventAt: number;
    observedAt: number; verificationFailed?: boolean;
  };
  assert.equal(deliveryReceipt.messageGuid, "sent-guid");
  assert.equal(deliveryReceipt.type, "delivered");
  assert.equal(deliveryReceipt.handle, "friend@example.com");
  assert.equal(deliveryReceipt.eventAt, deliveredAt);
  assert.ok(deliveryReceipt.observedAt > 0);
  assert.equal(deliveryReceipt.verificationFailed, false);

  const readAt = deliveredAt + 1_000;
  const readReceiptEvent = serviceEvent(service, "iblue-message-receipt");
  const readEvent = new Promise<{ type: string; data: {
    guid: string; dateRead: number; dateDelivered: number;
    iBlue?: { senderVerificationFailed?: boolean };
  } }>((resolve) => service.once("event", resolve));
  engine.emit("message.received", {
    uuid: "sent-guid",
    sender: "mailto:friend@example.com",
    participants: ["mailto:friend@example.com"],
    timestampMs: readAt,
    isSms: false,
    isStoredMessage: false,
    verificationFailed: true,
    attachments: [],
    readReceipt: true,
  });
  const readUpdate = await readEvent;
  assert.equal(readUpdate.type, "updated-message");
  assert.equal(readUpdate.data.guid, "sent-guid");
  assert.equal(readUpdate.data.dateRead, readAt);
  assert.equal(readUpdate.data.dateDelivered, deliveredAt);
  assert.equal(readUpdate.data.iBlue?.senderVerificationFailed, true);
  const readReceipt = await readReceiptEvent as {
    messageGuid: string; type: string; handle?: string; eventAt: number;
    verificationFailed?: boolean;
  };
  assert.equal(readReceipt.messageGuid, "sent-guid");
  assert.equal(readReceipt.type, "read");
  assert.equal(readReceipt.handle, "friend@example.com");
  assert.equal(readReceipt.eventAt, readAt);
  assert.equal(readReceipt.verificationFailed, true);

  const secondReadAt = readAt + 1_000;
  const secondReadReceiptEvent = serviceEvent(service, "iblue-message-receipt");
  engine.emit("message.received", {
    uuid: "sent-guid",
    sender: "mailto:second@example.com",
    participants: ["mailto:friend@example.com", "mailto:second@example.com"],
    timestampMs: secondReadAt,
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    readReceipt: true,
  });
  const secondReadReceipt = await secondReadReceiptEvent as {
    messageGuid: string; type: string; handle?: string; eventAt: number;
  };
  assert.equal(secondReadReceipt.handle, "second@example.com");
  assert.equal(secondReadReceipt.eventAt, secondReadAt);
  assert.equal(store.getMessage("sent-guid")?.dateRead, readAt);

  const receiptsResponse = await fetch(
    `${listening.address}/api/v1/iblue/message/sent-guid/receipts?password=secret&type=read`,
  );
  const receiptsBody = await receiptsResponse.json() as {
    data: Array<{ type: string; handle?: string; eventAt: number; observedAt: number }>;
    metadata: { total: number; count: number };
  };
  assert.equal(receiptsResponse.status, 200, JSON.stringify(receiptsBody));
  assert.equal(receiptsBody.metadata.total, 2);
  assert.equal(receiptsBody.metadata.count, 2);
  assert.deepEqual(receiptsBody.data.map(({ type, handle, eventAt }) => ({ type, handle, eventAt })), [
    { type: "read", handle: "friend@example.com", eventAt: readAt },
    { type: "read", handle: "second@example.com", eventAt: secondReadAt },
  ]);

  await store.ingestIncoming({
    uuid: "incoming-unread-guid",
    sender: "mailto:friend@example.com",
    text: "mark this unread",
    participants: ["mailto:secondary@example.com"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    verificationFailed: false,
    attachments: [],
  }, snapshot.handles);
  store.markChatRead("iMessage;-;friend@example.com");
  const messageCountBeforeReflectedControls = store.countMessages();
  assert.ok((store.getMessage("incoming-unread-guid")?.dateRead ?? 0) > 0);

  const directChatGuid = encodeURIComponent("iMessage;-;friend@example.com");
  const markedUnread = await fetch(
    `${listening.address}/api/v1/chat/${directChatGuid}/unread?password=secret`,
    { method: "POST" },
  );
  assert.equal(markedUnread.status, 200);
  assert.equal(engine.unreads.length, 1);
  assert.deepEqual(engine.unreads[0]?.conversation.participants, ["mailto:friend@example.com"]);
  assert.equal(engine.unreads[0]?.forUuid, "incoming-unread-guid");
  assert.equal(store.getMessage("incoming-unread-guid")?.dateRead, null);

  const notified = await fetch(
    `${listening.address}/api/v1/message/sent-guid/notify?password=secret`,
    { method: "POST" },
  );
  const notifiedBody = await notified.json() as {
    status: number;
    data: { guid: string; didNotifyRecipient: boolean };
  };
  assert.equal(notifiedBody.status, 200);
  assert.equal(notifiedBody.data.guid, "sent-guid");
  assert.equal(notifiedBody.data.didNotifyRecipient, true);
  assert.equal(engine.notifications.length, 1);
  assert.equal(engine.notifications[0]?.forUuid, "sent-guid");

  store.markChatRead("iMessage;-;friend@example.com");
  const reflectedUnreadEvent = new Promise<{ type: string; data: { chatGuid: string; read: boolean } }>(
    (resolve) => service.once("event", resolve),
  );
  engine.emit("message.received", {
    uuid: "incoming-unread-guid",
    sender: "mailto:friend@example.com",
    participants: ["mailto:secondary@example.com"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    verificationFailed: false,
    attachments: [],
    markUnread: true,
  });
  assert.deepEqual(await reflectedUnreadEvent, {
    type: "chat-read-status-changed",
    data: { chatGuid: "iMessage;-;friend@example.com", read: false, iBlue: { senderVerificationFailed: false } },
  });
  assert.equal(store.countMessages(), messageCountBeforeReflectedControls);

  const reflectedNotifyEvent = new Promise<{ type: string; data: { guid: string; didNotifyRecipient: boolean } }>(
    (resolve) => service.once("event", resolve),
  );
  engine.emit("message.received", {
    uuid: "sent-guid",
    sender: "mailto:friend@example.com",
    participants: ["mailto:secondary@example.com"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    verificationFailed: false,
    attachments: [],
    notifyAnyway: true,
  });
  const reflectedNotify = await reflectedNotifyEvent;
  assert.equal(reflectedNotify.type, "updated-message");
  assert.equal(reflectedNotify.data.guid, "sent-guid");
  assert.equal(reflectedNotify.data.didNotifyRecipient, true);
  assert.equal(store.countMessages(), messageCountBeforeReflectedControls);

  const upload = new FormData();
  upload.set("attachment", new Blob([Buffer.from("purgly-image")], { type: "image/png" }), "purgly.png");
  const uploaded = await fetch(`${listening.address}/api/v1/attachment/upload?password=secret`, {
    method: "POST",
    body: upload,
  });
  const uploadedBody = await uploaded.json() as { status: number; data: { path: string } };
  assert.equal(uploadedBody.status, 200);
  assert.match(uploadedBody.data.path, /^[0-9a-f-]{36}\/purgly\.png$/);

  const multipartSent = await fetch(`${listening.address}/api/v1/message/multipart?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chatGuid: "iMessage;-;friend@example.com",
      tempGuid: "multipart-temp-guid",
      subject: "mixed content",
      selectedMessageGuid: "multipart-reply-target-guid",
      parts: [
        { partIndex: 0, text: "Hello " },
        { partIndex: 0, text: "friend", mention: "mailto:friend@example.com" },
        { partIndex: 1, attachment: uploadedBody.data.path, name: "purgly.png" },
      ],
    }),
  });
  const multipartBody = await multipartSent.json() as {
    status: number;
    message: string;
    data: { guid: string; tempGuid: string; text: string; partCount: number; attachments: unknown[] };
  };
  assert.equal(multipartBody.status, 200);
  assert.equal(multipartBody.message, "Message sent!");
  assert.equal(multipartBody.data.guid, "multipart-message-guid");
  assert.equal(multipartBody.data.tempGuid, "multipart-temp-guid");
  assert.equal(multipartBody.data.text, "Hello friend");
  assert.equal(multipartBody.data.partCount, 2);
  assert.equal(multipartBody.data.attachments.length, 1);
  assert.equal(engine.multiparts.at(-1)?.params.replyGuid, "multipart-reply-target-guid");
  assert.equal(engine.multiparts.at(-1)?.params.replyPart, "0");
  assert.deepEqual(engine.multiparts.at(-1)?.data, [Buffer.from("purgly-image")]);
  assert.deepEqual(engine.multiparts.at(-1)?.params.parts.map((part) => ({
    partIndex: part.partIndex,
    text: part.text,
    mention: part.mention,
    filename: part.filename,
    mimeType: part.mimeType,
    utiType: part.utiType,
  })), [
    { partIndex: 0, text: "Hello ", mention: undefined, filename: undefined, mimeType: undefined, utiType: undefined },
    { partIndex: 0, text: "friend", mention: "mailto:friend@example.com", filename: undefined, mimeType: undefined, utiType: undefined },
    { partIndex: 1, text: undefined, mention: undefined, filename: "purgly.png", mimeType: "image/png", utiType: "public.png" },
  ]);

  const reusedUpload = await fetch(`${listening.address}/api/v1/message/multipart?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chatGuid: "iMessage;-;friend@example.com",
      parts: [{ partIndex: 0, attachment: uploadedBody.data.path, name: "purgly.png" }],
    }),
  });
  assert.equal(reusedUpload.status, 400);

  const queried = await fetch(`${listening.address}/api/v1/message/query?guid=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatGuid: "iMessage;-;friend@example.com" }),
  });
  const queriedBody = await queried.json() as {
    metadata: { total: number };
    data: Array<{ originalROWID: number }>;
  };
  assert.equal(queriedBody.metadata.total, 5);
  assert.equal(queriedBody.data.length, 5);

  const rowIds = queriedBody.data.map((message) => message.originalROWID).sort((a, b) => a - b);
  const incremental = await fetch(`${listening.address}/api/v1/message/query?guid=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      with: ["chats", "attachments", "handle"],
      where: [
        { statement: "message.ROWID > :startRowId", args: { startRowId: rowIds[0] } },
        { statement: "message.ROWID <= :endRowId", args: { endRowId: rowIds.at(-1) } },
      ],
      offset: 0,
      limit: 1000,
    }),
  });
  const incrementalBody = await incremental.json() as {
    metadata: { total: number };
    data: Array<{ originalROWID: number }>;
  };
  assert.equal(incrementalBody.metadata.total, 4);
  assert.deepEqual(
    incrementalBody.data.map((message) => message.originalROWID).sort((a, b) => a - b),
    rowIds.slice(1),
  );

  const count = await fetch(`${listening.address}/api/v1/message/count?password=secret`);
  assert.deepEqual(await count.json(), { status: 200, message: "Success", data: { total: 5 } });

  const pollSessionId = "cba9de14-dd9a-45c5-bb63-989e6e32c538";
  const pollBundleId =
    "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.messages.Polls";
  const pollUrl = (item: unknown): string =>
    `data:,${Buffer.from(JSON.stringify({ version: 1, item })).toString("base64")}`;
  const pollEvent = serviceEvent(service, "new-message");
  engine.emit("message.received", {
    uuid: "api-poll-guid",
    sender: "mailto:friend@example.com",
    text: "\ufffc",
    participants: ["mailto:friend@example.com"],
    timestampMs: 4_500,
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    appBalloon: {
      bundleId: pollBundleId,
      appName: "Polls",
      sessionId: pollSessionId,
      url: pollUrl({
        creatorHandle: "friend@example.com",
        title: "Lunch?",
        orderedPollOptions: [
          { optionIdentifier: "OPTION-1", text: "Tacos" },
          { optionIdentifier: "OPTION-2", text: "Pizza" },
        ],
      }),
      isLive: true,
    },
  });
  await pollEvent;
  const firstVoteEvent = serviceEvent(service, "new-message");
  engine.emit("message.received", {
    uuid: "api-poll-friend-vote-guid",
    sender: "mailto:friend@example.com",
    text: "\ufffd",
    participants: ["mailto:friend@example.com"],
    timestampMs: 4_501,
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    tapback: { type: 7, targetUuid: "api-poll-guid", remove: false },
    appBalloon: {
      bundleId: pollBundleId,
      appName: "Polls",
      sessionId: pollSessionId,
      url: pollUrl({
        votes: [
          { voteOptionIdentifier: "OPTION-1", participantHandle: "friend@example.com" },
          { voteOptionIdentifier: "OPTION-2", participantHandle: "friend@example.com" },
        ],
      }),
      isLive: false,
    },
  });
  const receivedVote = await firstVoteEvent as {
    associatedMessageType: string;
    iBlue: { pollVote: { participantHandle: string; votes: unknown[] } };
  };
  assert.equal(receivedVote.associatedMessageType, "poll-vote");
  assert.equal(receivedVote.iBlue.pollVote.participantHandle, "friend@example.com");
  assert.equal(receivedVote.iBlue.pollVote.votes.length, 2);

  const fetchedPoll = await fetch(
    `${listening.address}/api/v1/iblue/poll/api-poll-guid?password=secret`,
  );
  const fetchedPollBody = await fetchedPoll.json() as {
    data: { votes: Array<{ optionIdentifier: string; participantHandle: string }> };
  };
  assert.deepEqual(fetchedPollBody.data.votes, [
    { optionIdentifier: "OPTION-1", participantHandle: "friend@example.com" },
    { optionIdentifier: "OPTION-2", participantHandle: "friend@example.com" },
  ]);

  const jadeVote = await fetch(
    `${listening.address}/api/v1/iblue/poll/api-poll-guid/vote?password=secret`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionIdentifiers: ["OPTION-2"] }),
    },
  );
  assert.equal(jadeVote.status, 200);
  assert.equal(engine.pollVotes.at(-1)?.from, "mailto:secondary@example.com");
  assert.equal(engine.pollVotes.at(-1)?.targetUuid, "api-poll-guid");
  assert.deepEqual(JSON.parse(engine.pollVotes.at(-1)?.pollResponseJson ?? "{}"), {
    item: {
      votes: [{
        voteOptionIdentifier: "OPTION-2",
        participantHandle: "secondary@example.com",
      }],
    },
    version: 1,
  });
  const jadeVoteBody = await jadeVote.json() as {
    data: { poll: { votes: Array<{ optionIdentifier: string; participantHandle: string }> } };
  };
  assert.deepEqual(jadeVoteBody.data.poll.votes, [
    { optionIdentifier: "OPTION-1", participantHandle: "friend@example.com" },
    { optionIdentifier: "OPTION-2", participantHandle: "friend@example.com" },
    { optionIdentifier: "OPTION-2", participantHandle: "secondary@example.com" },
  ]);

  const directAttachment = new FormData();
  // Match the BlueBubbles app's field order: the file is added before the
  // metadata fields. The server must finish streaming it before reading fields.
  directAttachment.set(
    "attachment",
    new Blob([Buffer.from("direct-attachment")], { type: "text/plain" }),
    "direct.txt",
  );
  directAttachment.set("chatGuid", "iMessage;-;friend@example.com");
  directAttachment.set("tempGuid", "direct-attachment-temp");
  directAttachment.set("name", "direct.txt");
  directAttachment.set("subject", "attachment caption");
  directAttachment.set("effectId", "com.apple.messages.effect.CKSlamEffect");
  directAttachment.set("isAudioMessage", "true");
  directAttachment.set("selectedMessageGuid", "attachment-reply-target-guid");
  const directAttachmentSent = await fetch(
    `${listening.address}/api/v1/message/attachment?password=secret`,
    { method: "POST", body: directAttachment },
  );
  const directAttachmentBody = await directAttachmentSent.json() as {
    status: number;
    data: { guid: string; tempGuid: string; attachments: Array<{ guid: string }> };
  };
  assert.equal(directAttachmentBody.status, 200);
  assert.equal(directAttachmentBody.data.guid, "attachment-message-guid");
  assert.equal(directAttachmentBody.data.tempGuid, "direct-attachment-temp");
  assert.equal(directAttachmentBody.data.attachments.length, 1);
  assert.equal(engine.attachments.at(-1)?.params.caption, "attachment caption");
  assert.equal(engine.attachments.at(-1)?.params.effectId, "com.apple.messages.effect.CKSlamEffect");
  assert.equal(engine.attachments.at(-1)?.params.isAudioMessage, true);
  assert.equal(store.getMessage("attachment-message-guid")?.isAudioMessage, true);
  assert.deepEqual(engine.attachments.at(-1)?.data, Buffer.from("direct-attachment"));
  assert.equal(engine.attachments.at(-1)?.params.replyGuid, "attachment-reply-target-guid");
  assert.equal(engine.attachments.at(-1)?.params.replyPart, "0");

  const attachmentGuid = directAttachmentBody.data.attachments[0]!.guid;
  const downloaded = await fetch(
    `${listening.address}/api/v1/attachment/${attachmentGuid}/download?password=secret`,
  );
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), Buffer.from("direct-attachment"));
  const forceDownloaded = await fetch(
    `${listening.address}/api/v1/attachment/${attachmentGuid}/download/force?password=secret`,
  );
  assert.deepEqual(Buffer.from(await forceDownloaded.arrayBuffer()), Buffer.from("direct-attachment"));
  const embeddedMedia = await fetch(
    `${listening.address}/api/v1/message/attachment-message-guid/embedded-media?password=secret`,
  );
  assert.equal(embeddedMedia.status, 200);
  assert.deepEqual(Buffer.from(await embeddedMedia.arrayBuffer()), Buffer.from("direct-attachment"));

  const groupGuid = service.createChat(["one@example.com", "two@example.com"], "Initial Group");
  const encodedGroupGuid = encodeURIComponent(groupGuid);
  const chatCount = await fetch(`${listening.address}/api/v1/chat/count?password=secret`);
  const chatCountBody = await chatCount.json() as {
    data: { total: number; breakdown: Record<string, number> };
  };
  assert.equal(chatCountBody.data.total, store.countChats().total);
  assert.deepEqual(chatCountBody.data.breakdown, store.countChats().breakdown);

  // Mirror FullSyncManager's first-time sync calls in the stock client:
  // count chats, request pages with lastMessage, then fetch each chat's
  // messages. These response fields are consumed directly by Chat.fromMap and
  // Message.fromMap rather than being optional display metadata.
  const syncChats = await fetch(`${listening.address}/api/v1/chat/query?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offset: 0, limit: 200, with: ["lastMessage"] }),
  });
  const syncChatsBody = await syncChats.json() as {
    status: number;
    data: Array<{
      guid: string;
      chatIdentifier: string;
      participants: Array<{ originalROWID: number; address: string }>;
      lastMessage?: { guid: string; originalROWID: number; attachments: unknown[] };
    }>;
    metadata: { total: number };
  };
  assert.equal(syncChatsBody.status, 200);
  assert.equal(syncChatsBody.metadata.total, chatCountBody.data.total);
  const syncDirectChat = syncChatsBody.data.find((chat) => chat.guid === "iMessage;-;friend@example.com");
  assert.ok(syncDirectChat);
  assert.equal(syncDirectChat.chatIdentifier, "friend@example.com");
  assert.ok(syncDirectChat.participants.some((participant) => participant.address === "friend@example.com"));
  assert.ok(syncDirectChat.participants[0]);
  assert.ok(Number.isInteger(syncDirectChat.participants[0].originalROWID));
  assert.ok(syncDirectChat.lastMessage);
  assert.ok(syncDirectChat.lastMessage.guid);
  assert.ok(Number.isInteger(syncDirectChat.lastMessage.originalROWID));
  assert.ok(Array.isArray(syncDirectChat.lastMessage.attachments));

  const syncMessages = await fetch(
    `${listening.address}/api/v1/chat/${directChatGuid}/message?password=secret&after=0&before=${Date.now()}&offset=0&limit=25&with=attachments%2Chandle%2Cmessage.attributedBody%2Cmessage.messageSummaryInfo%2Cmessage.payloadData`,
  );
  const syncMessagesBody = await syncMessages.json() as {
    status: number;
    data: Array<{ guid: string; originalROWID: number; attachments: unknown[]; chats?: unknown[] }>;
    metadata: { total: number; count: number };
  };
  assert.equal(syncMessagesBody.status, 200);
  assert.ok(syncMessagesBody.data.length > 0);
  assert.equal(syncMessagesBody.metadata.count, syncMessagesBody.data.length);
  assert.ok(syncMessagesBody.metadata.total >= syncMessagesBody.metadata.count);
  assert.ok(syncMessagesBody.data.every((message) => Number.isInteger(message.originalROWID)));
  assert.ok(syncMessagesBody.data.every((message) => Array.isArray(message.attachments)));

  const totals = await fetch(
    `${listening.address}/api/v1/server/statistics/totals?password=secret&only=messages,chats,attachments`,
  );
  assert.deepEqual((await totals.json() as { data: unknown }).data, {
    messages: store.countMessages(),
    chats: store.countChats().total,
    attachments: store.countAttachments(),
  });
  const mediaTotals = await fetch(
    `${listening.address}/api/v1/server/statistics/media?password=secret&only=images,videos,locations`,
  );
  assert.deepEqual((await mediaTotals.json() as { data: unknown }).data, {
    images: 2,
    videos: 0,
    locations: 0,
  });
  const mediaByChat = await fetch(
    `${listening.address}/api/v1/server/statistics/media/chat?password=secret&only=images`,
  );
  assert.deepEqual((await mediaByChat.json() as { data: unknown }).data, [{
    chatGuid: "iMessage;-;friend@example.com",
    groupName: null,
    totals: { images: 2 },
  }]);
  const renamedGroup = await fetch(
    `${listening.address}/api/v1/chat/${encodedGroupGuid}?password=secret`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Renamed Group" }),
    },
  );
  const renamedGroupBody = await renamedGroup.json() as {
    status: number;
    data: { guid: string; displayName: string };
  };
  assert.equal(renamedGroupBody.status, 200);
  assert.equal(renamedGroupBody.data.guid, groupGuid);
  assert.equal(renamedGroupBody.data.displayName, "Renamed Group");
  assert.equal(engine.groupRenames.at(-1)?.newName, "Renamed Group");

  const participantAdded = await fetch(
    `${listening.address}/api/v1/chat/${encodedGroupGuid}/participant/add?password=secret`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "three@example.com" }),
    },
  );
  const participantAddedBody = await participantAdded.json() as {
    status: number;
    data: { participants: Array<{ address: string }> };
  };
  assert.equal(participantAddedBody.status, 200);
  assert.deepEqual(
    participantAddedBody.data.participants.map((participant) => participant.address).sort(),
    ["one@example.com", "three@example.com", "two@example.com"],
  );
  const addVersion = engine.groupParticipants.at(-1)?.groupVersion ?? 0;

  const participantRemoved = await fetch(
    `${listening.address}/api/v1/chat/${encodedGroupGuid}/participant/remove?password=secret`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "three@example.com" }),
    },
  );
  assert.equal(participantRemoved.status, 200);
  assert.ok((engine.groupParticipants.at(-1)?.groupVersion ?? 0) > addVersion);

  const iconForm = new FormData();
  iconForm.set("icon", new Blob([Buffer.from("group-icon-bytes")], { type: "image/png" }), "group.png");
  const iconSet = await fetch(
    `${listening.address}/api/v1/chat/${encodedGroupGuid}/icon?password=secret`,
    { method: "POST", body: iconForm },
  );
  assert.equal(iconSet.status, 200);
  assert.deepEqual(engine.groupIcons.at(-1)?.data, Buffer.from("group-icon-bytes"));
  const iconGet = await fetch(
    `${listening.address}/api/v1/chat/${encodedGroupGuid}/icon?password=secret`,
  );
  assert.equal(iconGet.status, 200);
  assert.equal(iconGet.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await iconGet.arrayBuffer()), Buffer.from("group-icon-bytes"));
  const iconRemoved = await fetch(
    `${listening.address}/api/v1/chat/${encodedGroupGuid}/icon?password=secret`,
    { method: "DELETE" },
  );
  assert.equal(iconRemoved.status, 200);
  assert.equal(engine.groupIcons.at(-1)?.params.path, undefined);
  const missingIcon = await fetch(
    `${listening.address}/api/v1/chat/${encodedGroupGuid}/icon?password=secret`,
  );
  assert.equal(missingIcon.status, 404);

  // A durable iMessage group GUID remains a group after it drops to one
  // remote participant. This also exercises BB's primary DELETE route rather
  // than only the POST /participant/remove alias.
  const reducedGroup = await fetch(
    `${listening.address}/api/v1/chat/${encodedGroupGuid}/participant?password=secret`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "two@example.com" }),
    },
  );
  const reducedGroupBody = await reducedGroup.json() as {
    status: number;
    data: { participants: Array<{ address: string }> };
  };
  assert.equal(reducedGroup.status, 200);
  assert.deepEqual(reducedGroupBody.data.participants.map((participant) => participant.address), ["one@example.com"]);

  const participantLeftEvent = serviceEvent(service, "participant-left");
  const leftGroup = await fetch(
    `${listening.address}/api/v1/chat/${encodedGroupGuid}/leave?password=secret`,
    { method: "POST" },
  );
  const participantLeft = await participantLeftEvent as {
    itemType: number;
    groupActionType: number;
    otherHandle: number;
  };
  assert.equal(leftGroup.status, 200);
  assert.equal((await leftGroup.json() as { message: string }).message, "Successfully left chat!");
  assert.equal(engine.groupLeaves.length, 1);
  assert.equal(engine.groupLeaves[0]?.from, "mailto:secondary@example.com");
  assert.deepEqual(engine.groupLeaves[0]?.conversation.participants, ["mailto:one@example.com"]);
  assert.equal(participantLeft.itemType, 3);
  assert.equal(participantLeft.groupActionType, 0);
  assert.ok(participantLeft.otherHandle > 0);

  const availability = await fetch(
    `${listening.address}/api/v1/handle/availability/imessage?password=secret&address=friend%40example.com`,
  );
  assert.deepEqual(await availability.json(), {
    status: 200,
    message: "Success",
    data: { available: true },
  });
  const facetimeAvailability = await fetch(
    `${listening.address}/api/v1/handle/availability/facetime?password=secret&address=friend%40example.com`,
  );
  assert.deepEqual(await facetimeAvailability.json(), {
    status: 200,
    message: "Success",
    data: { available: false },
  });
  const contacts = await fetch(`${listening.address}/api/v1/contact?password=secret`);
  assert.deepEqual((await contacts.json() as { data: unknown }).data, []);
  const queriedContacts = await fetch(`${listening.address}/api/v1/contact/query?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addresses: ["friend@example.com"] }),
  });
  assert.deepEqual((await queriedContacts.json() as { data: unknown }).data, []);
  const profileVcf = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:Example;API Jane;;;",
    "FN:API Jane Example",
    "EMAIL:friend@example.com",
    "PHOTO;ENCODING=b;TYPE=PNG:iVBORw0KGgo=",
    "END:VCARD",
  ].join("\r\n");
  const importedContacts = await fetch(`${listening.address}/api/v1/iblue/contact/vcf?password=secret`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ vcf: profileVcf }),
  });
  assert.deepEqual((await importedContacts.json() as { data: unknown }).data, { imported: 1 });
  const loadedProfileVcf = await fetch(`${listening.address}/api/v1/iblue/contact/vcf?password=secret`);
  assert.match((await loadedProfileVcf.json() as { data: string }).data, /API Jane Example/);
  const iBlueContacts = await fetch(
    `${listening.address}/api/v1/iblue/contact?password=secret&search=Jane`,
  );
  const iBlueContactsBody = await iBlueContacts.json() as {
    data: Array<{
      address: string;
      displayName: string;
      source: string;
      hasAvatar: boolean;
      updatedAt: number;
    }>;
  };
  assert.deepEqual(iBlueContactsBody.data, [{
    address: "friend@example.com",
    service: "iMessage",
    displayName: "API Jane Example",
    firstName: "API Jane",
    lastName: "Example",
    source: "profile-vcf",
    hasAvatar: true,
    updatedAt: iBlueContactsBody.data[0]?.updatedAt,
  }]);
  const contactAvatar = await fetch(
    `${listening.address}/api/v1/iblue/contact/friend%40example.com/avatar?password=secret`,
  );
  assert.equal(contactAvatar.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await contactAvatar.arrayBuffer()), Buffer.from("iVBORw0KGgo=", "base64"));
  const shareContactStatus = await fetch(
    `${listening.address}/api/v1/chat/${directChatGuid}/share/contact/status?password=secret`,
  );
  assert.deepEqual((await shareContactStatus.json() as { data: unknown }).data, false);

  const handles = await fetch(`${listening.address}/api/v1/handle/query?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit: 100 }),
  });
  const handlesBody = await handles.json() as {
    data: Array<{ address: string; iBlue?: { contact?: { displayName: string } } }>;
  };
  assert.deepEqual(handlesBody.data.map((handle) => handle.address).sort(), [
    "friend@example.com",
    "one@example.com",
    "secondary@example.com",
  ]);
  assert.equal(
    handlesBody.data.find((handle) => handle.address === "friend@example.com")?.iBlue?.contact?.displayName,
    "API Jane Example",
  );

  const locationEvent = serviceEvent(service, "new-message");
  engine.emit("message.received", {
    uuid: "api-location-guid",
    sender: "mailto:friend@example.com",
    text: "\ufffc",
    participants: ["mailto:friend@example.com"],
    timestampMs: 4321,
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    appBalloon: {
      bundleId: "com.apple.Maps.MessagesExtension",
      appName: "Maps",
      url: "https://maps.apple.com/?ll=37.3349,-122.009",
      isLive: false,
      imageTitle: "Apple Park",
      subcaption: "Cupertino, CA",
    },
  });
  const locationMessage = await locationEvent as {
    iBlue: { sharedLocation: { latitude: number; longitude: number } };
  };
  assert.equal(locationMessage.iBlue.sharedLocation.latitude, 37.3349);
  assert.equal(locationMessage.iBlue.sharedLocation.longitude, -122.009);
  const locations = await fetch(`${listening.address}/api/v1/iblue/location/query?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatGuid: "iMessage;-;friend@example.com" }),
  });
  const locationsBody = await locations.json() as { data: Array<{ messageGuid: string; label: string }> };
  assert.deepEqual(locationsBody.data.map(({ messageGuid, label }) => ({ messageGuid, label })), [{
    messageGuid: "api-location-guid",
    label: "Apple Park",
  }]);
  const location = await fetch(
    `${listening.address}/api/v1/iblue/location/api-location-guid?password=secret`,
  );
  assert.equal((await location.json() as { data: { address: string } }).data.address, "Cupertino, CA");
  const liveLocations = await fetch(
    `${listening.address}/api/v1/iblue/location/live?password=secret&address=friend%40example.com`,
  );
  const liveLocationsBody = await liveLocations.json() as {
    data: Array<{ address: string; latitude: number; locationUpdatedAt: number; expiresAt: number | null }>;
  };
  assert.deepEqual(liveLocationsBody.data, [{
    source: "find-my",
    followId: "findmy-follow-1",
    address: "friend@example.com",
    acceptedHandles: ["friend@example.com"],
    fromHandles: ["secondary@example.com"],
    isActive: true,
    isFromMessages: true,
    locatingInProgress: false,
    expiresAt: null,
    sharingUpdatedAt: 4_300,
    latitude: 37.335,
    longitude: -122.01,
    altitude: 12,
    horizontalAccuracy: 4,
    verticalAccuracy: 8,
    locationUpdatedAt: 4_400,
    isInaccurate: false,
    isOld: false,
    formattedAddress: "One Apple Park Way\nCupertino, CA",
    locality: "Cupertino",
    stateCode: "CA",
    countryCode: "US",
  }]);
  assert.deepEqual(engine.findMyRequests, ["friend@example.com"]);

  const edited = await fetch(`${listening.address}/api/v1/message/sent-guid/edit?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ editedMessage: "hello, edited" }),
  });
  const editedBody = await edited.json() as { data: { text: string; dateEdited: number } };
  assert.equal(editedBody.data.text, "hello, edited");
  assert.ok(editedBody.data.dateEdited > 0);

  // BlueBubbles clients also send edit and unsend with the message GUID in the
  // body instead of the path.
  const editedByBody = await fetch(`${listening.address}/api/v1/message/edit?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chatGuid: "iMessage;-;friend@example.com",
      messageGuid: "sent-guid",
      editedMessage: "hello, edited again",
      backwardsCompatibilityMessage: "hello, edited again",
      partIndex: 0,
    }),
  });
  const editedByBodyPayload = await editedByBody.json() as { data: { text: string } };
  assert.equal(editedByBodyPayload.data.text, "hello, edited again");

  const editMissingGuid = await fetch(`${listening.address}/api/v1/message/edit?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ editedMessage: "no target" }),
  });
  assert.equal(editMissingGuid.status, 400);

  const typing = await fetch(
    `${listening.address}/api/v1/chat/${encodeURIComponent("iMessage;-;friend@example.com")}/typing?password=secret`,
    { method: "POST" },
  );
  assert.equal(typing.status, 200);

  // Clients announce typing as a JSON-typed POST carrying no body.
  const typingWithoutBody = await fetch(
    `${listening.address}/api/v1/chat/${encodeURIComponent("iMessage;-;friend@example.com")}/typing?password=secret`,
    { method: "POST", headers: { "content-type": "application/json" } },
  );
  assert.equal(typingWithoutBody.status, 200);
  assert.equal(engine.typing.at(-1)?.active, true);

  const malformedJson = await fetch(`${listening.address}/api/v1/message/text?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(malformedJson.status, 400);

  const unsent = await fetch(`${listening.address}/api/v1/message/sent-guid/unsend?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const unsentBody = await unsent.json() as { data: { dateRetracted: number } };
  assert.ok(unsentBody.data.dateRetracted > 0);
  assert.equal(engine.unsends.length, 1);

  const deletedByBody = await fetch(`${listening.address}/api/v1/message/delete?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chatGuid: "iMessage;-;friend@example.com",
      messageGuid: "sent-guid",
      partIndex: 0,
    }),
  });
  const deletedByBodyPayload = await deletedByBody.json() as { data: { dateRetracted: number } };
  assert.equal(deletedByBody.status, 200);
  assert.ok(deletedByBodyPayload.data.dateRetracted > 0);

  const unauthorizedSocket = socketClient(listening.address, {
    query: { password: "wrong" },
    transports: ["websocket"],
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("unauthorized Socket.IO client was not rejected")), 1_000);
    const rejected = (): void => {
      clearTimeout(timer);
      resolve();
    };
    unauthorizedSocket.once("disconnect", rejected);
    unauthorizedSocket.once("connect_error", rejected);
  });
  assert.equal(unauthorizedSocket.connected, false);
  unauthorizedSocket.close();

  socket = socketClient(listening.address, { query: { password: "secret" }, transports: ["websocket"] });
  await new Promise<void>((resolve, reject) => {
    socket!.once("connect", resolve);
    socket!.once("connect_error", reject);
  });
  const event = new Promise<{ guid: string }>((resolve) => socket!.once("new-message", resolve));
  service.dispatch("new-message", { guid: "socket-guid" });
  assert.equal((await event).guid, "socket-guid");

  const realtimeResponse = await fetch(
    `${listening.address}/api/v1/iblue/facetime/realtime?password=secret`,
  );
  const realtime = await realtimeResponse.json() as {
    data: { inboundMedia: { available: boolean; explicitOptIn: boolean; webhookDelivery: boolean } };
  };
  assert.equal(realtime.data.inboundMedia.available, false);
  assert.equal(realtime.data.inboundMedia.explicitOptIn, true);
  assert.equal(realtime.data.inboundMedia.webhookDelivery, false);
  const calls = await socketAck<{ status: number; data: unknown[] }>(socket, "facetime-call-list", {});
  assert.equal(calls.status, 200);
  assert.deepEqual(calls.data, []);
  const unavailableStream = await socketAck<{ status: number }>(
    socket,
    "facetime-media-subscribe",
    { callId: "missing-call" },
  );
  assert.equal(unavailableStream.status, 501);
  const unavailableStop = await socketAck<{ status: number }>(
    socket,
    "facetime-call-stop",
    { callId: "missing-call" },
  );
  assert.equal(unavailableStop.status, 501);
  const missingCall = await socketAck<{ status: number }>(
    socket,
    "facetime-call-get",
    { callId: "missing-call" },
  );
  assert.equal(missingCall.status, 404);
  const missingSubscription = await socketAck<{ status: number; data: { removed: boolean } }>(
    socket,
    "facetime-media-unsubscribe",
    { callId: "missing-call" },
  );
  assert.equal(missingSubscription.status, 200);
  assert.equal(missingSubscription.data.removed, false);

  let rawFrameLeaked = false;
  socket.once("ft-media-frame", () => { rawFrameLeaked = true; });
  engine.emit("facetime.media.frame", {
    sessionId: "SESSION",
    kind: "audio",
    codec: "evs",
    payloadType: 108,
    rtpTimestamp: 480,
    dataBase64: Buffer.from([1, 2, 3]).toString("base64"),
    receivedAt: Date.now(),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rawFrameLeaked, false, "raw FaceTime media must require an explicit subscription");

  const metadataEvent = new Promise<{ status: number; data: { private_api: boolean } }>((resolve) =>
    socket!.once("server-metadata", resolve),
  );
  socket.emit("get-server-metadata", {});
  assert.equal((await metadataEvent).data.private_api, true);

  const serverConfig = await socketAck<{
    status: number;
    data: { encrypt_coms: boolean; enable_private_api: boolean; iBlue: { contactsSource: string } };
  }>(socket, "get-server-config", {});
  assert.equal(serverConfig.status, 200);
  assert.equal(serverConfig.data.encrypt_coms, false);
  assert.equal(serverConfig.data.enable_private_api, true);
  assert.equal(serverConfig.data.iBlue.contactsSource, "profile-local-vcf");

  const savedVcf = await socketAck<{ status: number }>(socket, "save-vcf", {
    vcf: "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Profile Contact\r\nEND:VCARD\r\n",
  });
  assert.equal(savedVcf.status, 200);
  const loadedVcf = await socketAck<{ status: number; data: string }>(socket, "get-vcf", {});
  assert.equal(loadedVcf.status, 200);
  assert.match(loadedVcf.data, /FN:Profile Contact/);
  const unsupportedFcm = await socketAck<{ status: number; message: string; error: { message: string } }>(
    socket,
    "add-fcm-device",
    { deviceName: "test", deviceId: "token" },
  );
  assert.equal(unsupportedFcm.status, 501);
  assert.match(unsupportedFcm.message, /Socket\.IO add-fcm-device/);
  assert.equal(unsupportedFcm.error.message, "UNSUPPORTED_BY_DIRECT_IDS");

  // Every request event at the pinned BlueBubbles commit must acknowledge or
  // emit an error. Socket.IO has no generic unknown-method response, so a
  // missing handler otherwise leaves integrations hanging until timeout.
  const pinnedSocketRequests = [
    "add-fcm-device",
    "add-participant",
    "change-proxy-service",
    "check-for-server-update",
    "get-attachment",
    "get-attachment-chunk",
    "get-chat",
    "get-chat-messages",
    "get-chats",
    "get-contacts-from-vcf",
    "get-fcm-client",
    "get-last-chat-message",
    "get-logs",
    "get-messages",
    "get-participants",
    "get-server-config",
    "get-server-metadata",
    "get-vcf",
    "mark-chat-read",
    "open-chat",
    "remove-participant",
    "rename-group",
    "restart-messages-app",
    "restart-private-api",
    "save-vcf",
    "send-message",
    "send-message-chunk",
    "send-reaction",
    "start-chat",
    "started-typing",
    "stopped-typing",
    "toggle-chat-read-status",
    "update-typing-status",
  ] as const;
  for (const requestEvent of pinnedSocketRequests) {
    const acknowledged = await Promise.race([
      socketAck<{ status: number }>(socket, requestEvent, {}),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error(`Socket.IO ${requestEvent} did not acknowledge`)),
        1_000,
      )),
    ]);
    assert.ok(Number.isInteger(acknowledged.status), `${requestEvent} returned no BlueBubbles status`);
  }

  const started = await socketAck<{ status: number; data: { guid: string } }>(socket, "start-chat", {
    participants: "another@example.com",
  });
  assert.equal(started.status, 200);
  assert.equal(started.data.guid, "iMessage;-;another@example.com");

  const socketRenamed = await socketAck<{ status: number; data: { displayName: string } }>(
    socket,
    "rename-group",
    { identifier: groupGuid, newName: "Socket Group" },
  );
  assert.equal(socketRenamed.status, 200);
  assert.equal(socketRenamed.data.displayName, "Socket Group");

  const socketAdded = await socketAck<{ status: number; data: { participants: Array<{ address: string }> } }>(
    socket,
    "add-participant",
    { identifier: groupGuid, address: "socket@example.com" },
  );
  assert.equal(socketAdded.status, 200);
  assert.ok(socketAdded.data.participants.some((participant) => participant.address === "socket@example.com"));
  const socketRemoved = await socketAck<{ status: number; data: { participants: Array<{ address: string }> } }>(
    socket,
    "remove-participant",
    { identifier: groupGuid, address: "socket@example.com" },
  );
  assert.equal(socketRemoved.status, 200);
  assert.ok(!socketRemoved.data.participants.some((participant) => participant.address === "socket@example.com"));

  const reacted = await socketAck<{ status: number; data: { associatedMessageGuid: string } }>(
    socket,
    "send-reaction",
    {
      chatGuid: "iMessage;-;friend@example.com",
      tempGuid: "tapback-temp",
      messageText: "Liked “hello”",
      actionMessageGuid: "sent-guid",
      actionMessageText: "hello",
      tapback: "like",
    },
  );
  assert.equal(reacted.status, 200);
  assert.equal(reacted.data.associatedMessageGuid, "sent-guid");
  assert.equal(engine.reactions.at(-1)?.reaction, "like");
  assert.equal(engine.reactions.at(-1)?.targetText, "hello, edited again");

  await service.sendReaction({
    chatGuid: "iMessage;-;friend@example.com",
    selectedMessageGuid: "attachment-message-guid",
    reaction: "laugh",
  });
  assert.equal(engine.reactions.at(-1)?.targetText, "\u{fffc}");

  const typed = await socketAck<{ status: number }>(socket, "started-typing", {
    chatGuid: "iMessage;-;friend@example.com",
  });
  assert.equal(typed.status, 200);
  assert.equal(engine.typing.at(-1)?.active, true);

  const read = await socketAck<{ status: number }>(socket, "mark-chat-read", {
    chatGuid: "iMessage;-;friend@example.com",
  });
  assert.equal(read.status, 200);
  assert.equal(engine.reads.length, 1);
  assert.equal(engine.reads[0]?.forUuid, "incoming-unread-guid");

  const firstChunk = await socketAck<{ status: number }>(socket, "send-message-chunk", {
    guid: "iMessage;-;friend@example.com",
    tempGuid: "chunk-message-temp",
    attachmentGuid: "chunk-attachment-temp",
    attachmentChunkStart: 0,
    attachmentData: Buffer.from("abc").toString("base64"),
    hasMore: true,
  });
  assert.equal(firstChunk.status, 200);
  const finalChunk = await socketAck<{ status: number }>(socket, "send-message-chunk", {
    guid: "iMessage;-;friend@example.com",
    tempGuid: "chunk-message-temp",
    attachmentGuid: "chunk-attachment-temp",
    attachmentChunkStart: 3,
    attachmentData: Buffer.from("def").toString("base64"),
    attachmentName: "chunk.txt",
    hasMore: false,
  });
  assert.equal(finalChunk.status, 200);
  assert.deepEqual(engine.attachments.at(-1)?.data, Buffer.from("abcdef"));

  const webhook = await fetch(`${listening.address}/api/v1/webhook?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `http://127.0.0.1:${webhookPort}/incoming`, events: ["new-message"] }),
  });
  assert.equal(webhook.status, 200);
  engine.emit("message.received", {
    uuid: "incoming-webhook-guid",
    sender: "mailto:webhook-sender@example.com",
    text: "delivered through IDS notification",
    participants: ["mailto:webhook-sender@example.com"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    verificationFailed: true,
    attachments: [],
  });
  const delivered = await Promise.race([
    webhookDelivery,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("webhook delivery timed out")), 2_000)),
  ]);
  assert.equal(delivered.type, "new-message");
  assert.equal(delivered.data.guid, "incoming-webhook-guid");
  assert.equal(delivered.data.iBlue?.senderVerificationFailed, true);

  const receiptWebhook = await fetch(`${listening.address}/api/v1/webhook?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `http://127.0.0.1:${webhookPort}/receipt`,
      events: ["iblue-message-receipt"],
    }),
  });
  assert.equal(receiptWebhook.status, 200);
  const receiptSocketDelivery = new Promise<{
    messageGuid: string; type: string; handle?: string;
  }>((resolve) => socket!.once("iblue-message-receipt", resolve));
  engine.emit("message.received", {
    uuid: "sent-guid",
    sender: "mailto:webhook-reader@example.com",
    participants: ["mailto:webhook-reader@example.com"],
    timestampMs: readAt + 2_000,
    isSms: false,
    isStoredMessage: false,
    attachments: [],
    readReceipt: true,
  });
  const [receiptWebhookPayload, receiptSocketPayload] = await Promise.all([
    Promise.race([
      receiptWebhookDelivery,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("receipt webhook delivery timed out")),
        2_000,
      )),
    ]),
    receiptSocketDelivery,
  ]);
  assert.equal(receiptWebhookPayload.type, "iblue-message-receipt");
  assert.equal(receiptWebhookPayload.data.messageGuid, "sent-guid");
  assert.equal(receiptWebhookPayload.data.type, "read");
  assert.equal(receiptWebhookPayload.data.handle, "webhook-reader@example.com");
  assert.equal(receiptSocketPayload.messageGuid, "sent-guid");
  assert.equal(receiptSocketPayload.type, "read");
  assert.equal(receiptSocketPayload.handle, "webhook-reader@example.com");

  const retryWebhook = await fetch(`${listening.address}/api/v1/webhook?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `http://127.0.0.1:${webhookPort}/retry`, events: ["new-message"] }),
  });
  assert.equal(retryWebhook.status, 200);
  engine.emit("message.received", {
    uuid: "incoming-webhook-retry-guid",
    sender: "mailto:webhook-sender@example.com",
    text: "retry this webhook once",
    participants: ["mailto:webhook-sender@example.com"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    verificationFailed: false,
    attachments: [],
  });
  const retried = await Promise.race([
    retryWebhookDelivery,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("webhook retry delivery timed out")),
      2_000,
    )),
  ]);
  assert.equal(retried.type, "new-message");
  assert.equal(retried.data.guid, "incoming-webhook-retry-guid");
  assert.equal(retryWebhookAttempts, 2);
  assert.equal(retryWebhookDeliveryIds.length, 2);
  assert.equal(retryWebhookDeliveryIds[0], retryWebhookDeliveryIds[1]);

  const aliasWebhook = await fetch(`${listening.address}/api/v1/webhook?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `http://127.0.0.1:${webhookPort}/aliases`,
      // This is the singular value exposed by BlueBubbles 1.9.9's official
      // webhook picker, even though the delivered event name is plural.
      events: ["imessage-alias-removed"],
    }),
  });
  assert.equal(aliasWebhook.status, 200);

  const officialOptionalWebhook = await fetch(`${listening.address}/api/v1/webhook?password=secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `http://127.0.0.1:${webhookPort}/official-optional-events`,
      events: [
        "server-update",
        "new-server",
        "new-findmy-location",
        "incoming-facetime",
        "ft-call-status-changed",
        "theme-backup-created",
        "theme-backup-updated",
        "theme-backup-deleted",
        "settings-backup-created",
        "settings-backup-updated",
        "settings-backup-deleted",
      ],
    }),
  });
  assert.equal(officialOptionalWebhook.status, 200);

  const typingTrust = new Promise<{ iBlue?: { senderVerificationFailed?: boolean } }>((resolve) =>
    socket!.once("typing-indicator", resolve),
  );
  engine.emit("message.received", {
    uuid: "unverified-typing-guid",
    sender: "mailto:webhook-sender@example.com",
    participants: ["mailto:webhook-sender@example.com"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    verificationFailed: true,
    attachments: [],
    typing: { active: true },
  });
  assert.equal((await typingTrust).iBlue?.senderVerificationFailed, true);

  const stoppedTyping = new Promise<{ display: boolean; guid: string }>((resolve) =>
    socket!.once("typing-indicator", resolve),
  );
  engine.emit("message.received", {
    uuid: "stopped-typing-guid",
    sender: "mailto:webhook-sender@example.com",
    participants: ["mailto:webhook-sender@example.com"],
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    verificationFailed: false,
    attachments: [],
    typing: { active: false },
  });
  assert.deepEqual(await stoppedTyping, {
    display: false,
    guid: "iMessage;-;webhook-sender@example.com",
    iBlue: { senderVerificationFailed: false },
  });

  const inboundParticipant = new Promise<{
    chats: Array<{ participants: Array<{ address: string }> }>;
  }>((resolve) => socket!.once("participant-added", resolve));
  engine.emit("message.received", {
    uuid: "incoming-participant-change",
    sender: "mailto:one@example.com",
    participants: ["mailto:one@example.com", "mailto:two@example.com", "mailto:incoming@example.com"],
    groupName: "Socket Group",
    senderGuid: groupGuid.split(";").slice(2).join(";"),
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    verificationFailed: false,
    attachments: [],
    participantChange: {
      participants: ["mailto:one@example.com", "mailto:two@example.com", "mailto:incoming@example.com"],
      groupVersion: 9_999_999_999,
    },
  });
  const inboundParticipantEvent = await inboundParticipant;
  assert.ok(inboundParticipantEvent.chats[0]?.participants.some(
    (participant) => participant.address === "incoming@example.com",
  ));

  const inboundLeave = new Promise<{ itemType: number; groupActionType: number }>((resolve) =>
    socket!.once("participant-left", resolve),
  );
  engine.emit("message.received", {
    uuid: "incoming-participant-leave",
    sender: "mailto:one@example.com",
    participants: ["mailto:one@example.com", "mailto:two@example.com", "mailto:incoming@example.com"],
    groupName: "Socket Group",
    senderGuid: groupGuid.split(";").slice(2).join(";"),
    timestampMs: Date.now(),
    isSms: false,
    isStoredMessage: false,
    verificationFailed: false,
    attachments: [],
    participantChange: {
      participants: ["mailto:two@example.com", "mailto:incoming@example.com"],
      groupVersion: 10_000_000_000,
    },
  });
  const inboundLeaveEvent = await inboundLeave;
  assert.equal(inboundLeaveEvent.itemType, 3);
  assert.equal(inboundLeaveEvent.groupActionType, 0);

  const aliasesRemoved = new Promise<{ aliases: string[] }>((resolve) =>
    socket!.once("imessage-aliases-removed", resolve),
  );
  engine.currentSnapshot = {
    ...engine.currentSnapshot,
    users: "users-after-alias-removal",
    handles: [],
  };
  engine.emit("account.stateChanged", {
    users: engine.currentSnapshot.users,
    handles: engine.currentSnapshot.handles,
  });
  assert.deepEqual(await aliasesRemoved, { aliases: ["secondary@example.com"] });
  const aliasWebhookEvent = await Promise.race([
    aliasWebhookDelivery,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("alias webhook delivery timed out")),
      2_000,
    )),
  ]);
  assert.equal(aliasWebhookEvent.type, "imessage-aliases-removed");
  assert.deepEqual(aliasWebhookEvent.data.aliases, ["secondary@example.com"]);
  assert.deepEqual(service.handles, []);

  const storedAttachmentPath = store.getAttachment(attachmentGuid)?.path;
  assert.ok(storedAttachmentPath);
  const deletedMessage = await fetch(
    `${listening.address}/api/v1/chat/${directChatGuid}/attachment-message-guid?password=secret`,
    { method: "DELETE" },
  );
  assert.equal(deletedMessage.status, 200);
  assert.equal(store.getMessage("attachment-message-guid"), undefined);
  assert.equal(store.getAttachment(attachmentGuid), undefined);
  await assert.rejects(stat(storedAttachmentPath));

  const deletedChat = await fetch(
    `${listening.address}/api/v1/chat/${encodedGroupGuid}?password=secret`,
    { method: "DELETE" },
  );
  assert.equal(deletedChat.status, 200);
  assert.equal(store.getChat(groupGuid), undefined);

  assert.equal(PINNED_BLUEBUBBLES_SOCKET_EVENTS.length, 34);
  for (const event of PINNED_BLUEBUBBLES_SOCKET_EVENTS) {
    if (event === "disconnect") continue;
    const payload: { status?: unknown; encrypted?: unknown } = await Promise.race([
      socketAck<{ status?: unknown; encrypted?: unknown }>(socket!, event, {}),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error(`Pinned Socket.IO request did not acknowledge: ${event}`)),
        1_000,
      )),
    ]);
    assert.equal(typeof payload.status, "number", event);
    assert.equal(payload.encrypted, false, event);
  }

  assert.equal(PINNED_BLUEBUBBLES_REST_ROUTES.length, 91);
  for (const route of PINNED_BLUEBUBBLES_REST_ROUTES) {
    const path = route.path
      .replace(":messageGuid", "missing-message")
      .replace(":call_uuid", "missing-call")
      .replace(":guid", "missing-guid")
      .replace(":id", "999999");
    const response = await fetch(`${listening.address}${path}?password=secret`, {
      method: route.method,
      ...(route.method === "GET" || route.method === "DELETE"
        ? {}
        : { headers: { "content-type": "application/json" }, body: "{}" }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    assert.match(contentType, /application\/json/i, `${route.method} ${route.path}`);
    const body = await response.json() as { status?: unknown; statusCode?: unknown };
    assert.equal(
      typeof body.status,
      "number",
      `${route.method} ${route.path} fell through to a non-BlueBubbles response: ${JSON.stringify(body)}`,
    );
    assert.equal(body.statusCode, undefined, `${route.method} ${route.path}`);
  }
});

function socketAck<T>(socket: Socket, event: string, params: unknown): Promise<T> {
  return new Promise<T>((resolve) => socket.emit(event, params, resolve));
}

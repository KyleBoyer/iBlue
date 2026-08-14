import { EventEmitter } from "node:events";

import type {
  EngineNotificationMap,
  EngineSnapshot,
  EngineVersion,
  IdsLookupResult,
  IdsRegistrationInspection,
  InitializeParams,
  NativeFindMyFollow,
  NativeCloudSyncAttachment,
  NativeCloudSyncChat,
  NativeCloudSyncMessage,
  SendComponentParams,
  SendConversationBackgroundParams,
  SendAttachmentParams,
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
} from "../types.js";
import { NativeRpcClient, type NativeRpcClientOptions } from "./rpc-client.js";

export interface LoginStartResult {
  needs2fa: boolean;
  challenge?: "trusted-device" | "sms";
}

export interface TwoFactorPhoneOption {
  id: number;
  lastTwoDigits: string;
}

export interface ICloudKeychainDevice {
  index: number;
  name: string;
  model: string;
}

export interface ICloudWebLoginStatus {
  ready: boolean;
  needs2fa: boolean;
  reusedSession: boolean;
  photosAvailable: boolean;
  pcsRequired: boolean;
}

export interface ICloudWebPhoneOption {
  id: number;
  lastTwoDigits: string;
  mode: string;
}

export interface FreshICloudPhotoShare {
  url: string;
  shareId: string;
  assetGuid: string;
  itemCount: number;
}

export interface ICloudContactsSyncResult {
  vcards: string[];
  syncedAt: number;
}

export interface CloudSyncPage {
  continuationToken?: string;
  status: number;
  done: boolean;
}

export interface CloudChatsPage extends CloudSyncPage {
  chats: NativeCloudSyncChat[];
}

export interface CloudMessagesPage extends CloudSyncPage {
  messages: NativeCloudSyncMessage[];
}

export interface CloudAttachmentsPage extends CloudSyncPage {
  attachments: NativeCloudSyncAttachment[];
}

export interface FocusPeersSyncPage {
  resolvedZone?: string;
  continuationToken?: string;
  done: boolean;
  fetched: number;
  inserted: number;
  alreadyKnown: number;
  decodeFailed: number;
  recordsSeen: number;
  injectedHandles: string[];
  clusterObservations: Array<{ channelId: string; senderHandle: string }>;
  discoverySummary?: string;
}

export interface FaceTimeSessionCreateParams {
  targets: string[];
  from?: string;
  displayName?: string;
  ringTtlSeconds?: number;
  ringOnMediaJoin?: boolean;
}

export interface FaceTimeSessionStart {
  sessionId: string;
  link: string;
  from: string;
  targets: string[];
  displayName: string;
  ringTtlSeconds: number;
  ringOnMediaJoin: boolean;
  state: "waiting-for-media";
}

export interface FaceTimeNativeMediaStart {
  sessionId: string;
  from: string;
  targets: string[];
  state: "allocated" | "ringing";
  transport: "iblue-quickrelay";
  topology: "one-to-one";
  mode?: "audio" | "video";
}

export interface FaceTimeIncomingSession {
  sessionId: string;
  state: "ringing" | "active" | "answered-elsewhere" | "declined";
  mode: "audio" | "video";
  caller?: string;
  participants: string[];
  myHandles: string[];
  startedAt?: number;
  nativeMediaAttached: boolean;
}

export interface FaceTimeNativeLiveAudioStart extends FaceTimeNativeMediaStart {
  mediaSource: "live-stream";
  audioFormat: {
    encoding: "pcm-f32le";
    sampleRate: 24_000;
    channels: 1;
    frameDurationMs: 20;
    frameBytes: 1_920;
  };
}

export interface FaceTimeNativeMediaStatus {
  sessionId: string;
  state:
    | "prepared"
    | "waiting-for-peer-template"
    | "streaming"
    | "draining"
    | "stream-ended"
    | "completed"
    | "failed"
    | "stopped";
  packetsTotal: number;
  payloadBytesTotal: number;
  packetsSent: number;
  payloadBytesSent: number;
  audioPacketsTotal: number;
  audioPayloadBytesTotal: number;
  audioPacketsSent: number;
  audioPayloadBytesSent: number;
  videoFramesTotal: number;
  videoFramesSent: number;
  videoSourceBytesTotal: number;
  videoPacketsSent: number;
  videoPayloadBytesSent: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  controlMessagesReceived: number;
  controlMessagesAuthenticated: number;
  controlMessagesSent: number;
  controlStreamStateSent: boolean;
  controlStreamStateAcknowledged: boolean;
  controlReady: boolean;
  controlParticipantContexts: number;
  controlPeerUuids: number;
  controlMediaKeys: number;
  controlLastError?: string;
  peerAudioFeedbackUpdates: number;
  peerAudioFeedbackSequence: number;
  peerAudioKbReceived: number;
  peerAudioPacketsReceived: number;
  peerAudioBurstLoss: number;
  peerAudioQueuingDelay?: number;
  peerAudioCurrentSendTimestamp?: number;
  peerAudioQ13OneWayDelay?: number;
  peerAudioOneWayDelayMs?: number;
  peerVideoBurstLoss?: number;
  peerVideoFrameSize?: number;
  peerVideoPacketLoss?: number;
  peerBandwidthEstimate?: number;
  peerEct?: number;
  peerCe?: number;
  peerAudioPayloadType?: number;
  peerAudioRtpExtensionProfile?: number;
  peerAudioRtpExtensionHex?: string;
  peerVideoPacketsReceived: number;
  peerVideoSsrc?: number;
  peerVideoRtpExtensionProfile?: number;
  peerVideoRtpExtensionHex?: string;
  mediaEpochUnixMs?: number;
  rtpTimestampBase?: number;
  audioLastPresentationTimeUs?: number;
  videoLastPresentationTimeUs?: number;
}

export interface FaceTimeNativeMediaStreamStatus {
  sessionId: string;
  enabled: boolean;
  audio: boolean;
  video: boolean;
  expiresAt: number | null;
}

export interface IMessageEngine {
  initialize(params: InitializeParams): Promise<EngineSnapshot>;
  loginStart(appleId: string, password: string): Promise<LoginStartResult>;
  login2faOptions(): Promise<{ phones: TwoFactorPhoneOption[] }>;
  loginRequestSms(phoneId: number): Promise<{ sent: boolean }>;
  loginSubmit2fa(code: string): Promise<{ accepted: boolean }>;
  loginFinish(): Promise<EngineSnapshot>;
  iCloudKeychainDevices?(): Promise<{ devices: ICloudKeychainDevice[] }>;
  joinICloudKeychain?(passcode: string, deviceIndex?: number): Promise<{ joined: boolean; detail: string }>;
  iCloudWebStatus?(): Promise<ICloudWebLoginStatus>;
  iCloudWebLoginStart?(): Promise<ICloudWebLoginStatus>;
  iCloudWeb2faOptions?(): Promise<{ phones: ICloudWebPhoneOption[] }>;
  iCloudWebRequestSms?(phoneId: number, mode?: string): Promise<{ sent: boolean }>;
  iCloudWebSubmit2fa?(
    code: string,
    phoneId?: number,
    mode?: string,
  ): Promise<ICloudWebLoginStatus>;
  iCloudWebPreparePhotos?(): Promise<ICloudWebLoginStatus>;
  createICloudPhotoShare?(params: {
    path: string;
    filename: string;
    mimeType: string;
    title?: string;
  }): Promise<FreshICloudPhotoShare>;
  syncICloudContacts?(): Promise<ICloudContactsSyncResult>;
  migrateCredentialToFile(keyPath: string): Promise<{ migrated: boolean; credentialBackend: string }>;
  startClient(): Promise<EngineSnapshot>;
  snapshot(): Promise<EngineSnapshot>;
  health(): Promise<{ clientStarted: boolean; secondsSinceLastInbound: number }>;
  refreshFindMyFollowing?(address?: string, findMyIds?: string[]): Promise<NativeFindMyFollow[]>;
  sendMessage(params: SendMessageParams): Promise<{ guid: string }>;
  sendComponent?(params: SendComponentParams): Promise<{ guid: string }>;
  setConversationBackground?(params: SendConversationBackgroundParams): Promise<{ guid: string }>;
  syncCloudChats?(continuationToken?: string): Promise<CloudChatsPage>;
  syncCloudMessages?(continuationToken?: string): Promise<CloudMessagesPage>;
  syncCloudAttachments?(continuationToken?: string): Promise<CloudAttachmentsPage>;
  syncFocusPeers?(cachedZone?: string, continuationToken?: string): Promise<FocusPeersSyncPage>;
  subscribeFocus?(handles: string[]): Promise<{ subscribed: string[] }>;
  shareFocus?(active: boolean, mode?: string): Promise<{ shared: boolean }>;
  sendReaction(params: SendReactionParams): Promise<{ guid: string }>;
  sendStickerReaction?(params: SendStickerReactionParams): Promise<{ guid: string }>;
  updateStickerReaction?(params: UpdateStickerReactionParams): Promise<{ guid: string }>;
  sendPollVote(params: SendPollVoteParams): Promise<{ guid: string }>;
  sendAttachment(params: SendAttachmentParams): Promise<{ guid: string }>;
  sendMultipartMessage(params: SendMultipartMessageParams): Promise<{ guid: string }>;
  renameGroup(params: SendGroupRenameParams): Promise<{ guid: string }>;
  changeGroupParticipants(params: SendGroupParticipantsParams): Promise<{ guid: string }>;
  leaveGroup(params: SendGroupLeaveParams): Promise<{ guid: string }>;
  setGroupIcon(params: SendGroupIconParams): Promise<{ guid: string }>;
  validateHandles(params: ValidateHandlesParams): Promise<{ available: string[] }>;
  lookupHandles(params: ValidateHandlesParams): Promise<IdsLookupResult>;
  validateHandlesHttp(params: ValidateHandlesParams): Promise<{ available: string[] }>;
  sendEdit(params: SendEditParams): Promise<{ guid: string }>;
  sendUnsend(params: SendUnsendParams): Promise<{ guid: string }>;
  sendTyping(params: SendTypingParams): Promise<{ sent: boolean }>;
  sendReadReceipt(params: SendReadReceiptParams): Promise<{ sent: boolean }>;
  sendMarkUnread(params: SendMarkUnreadParams): Promise<{ sent: boolean }>;
  sendNotify(params: SendNotifyParams): Promise<{ guid: string }>;
  createFaceTimeSession?(params: FaceTimeSessionCreateParams): Promise<FaceTimeSessionStart>;
  listFaceTimeSessions?(): Promise<unknown>;
  leaveFaceTimeSession?(sessionId: string): Promise<{ left: boolean; sessionId: string }>;
  ringFaceTimeSession?(sessionId: string, targets: string[]): Promise<{
    rang: boolean;
    sessionId: string;
    targets: string[];
  }>;
  confirmFaceTimeMediaJoined?(sessionId: string): Promise<{
    confirmed: boolean;
    sessionId: string;
  }>;
  createNativeFaceTimeMediaSession?(params: {
    targets: string[];
    from?: string;
    audioPath: string;
    videoPath?: string;
    videoDescriptionPath?: string;
    videoFrameDurationMs?: number;
    ring?: boolean;
  }): Promise<FaceTimeNativeMediaStart>;
  startNativeFaceTimeMediaSession?(sessionId: string): Promise<{
    started: boolean;
    sessionId: string;
    transport: "iblue-quickrelay";
  }>;
  nativeFaceTimeMediaStatus?(sessionId: string): Promise<FaceTimeNativeMediaStatus>;
  listIncomingFaceTimeSessions?(): Promise<FaceTimeIncomingSession[]>;
  answerIncomingFaceTimeSession?(params: {
    sessionId: string;
    audioPath?: string;
    videoPath?: string;
    videoDescriptionPath?: string;
    videoFrameDurationMs?: number;
  }): Promise<FaceTimeIncomingSession>;
  declineIncomingFaceTimeSession?(sessionId: string): Promise<FaceTimeIncomingSession>;
  createNativeFaceTimeLiveAudioSession?(params: {
    targets: string[];
    from?: string;
    ring?: boolean;
  }): Promise<FaceTimeNativeLiveAudioStart>;
  startNativeFaceTimeLiveAudioStream?(sessionId: string, timing?: {
    mediaEpochUnixMs?: number;
    rtpTimestampBase?: number;
  }): Promise<{
    started: boolean;
    sessionId: string;
    frameBytes: 1_920;
    queueCapacityFrames: number;
    mediaEpochUnixMs: number;
    rtpTimestampBase: number;
  }>;
  pushNativeFaceTimeLiveAudioFrame?(sessionId: string, frame: Buffer, presentationTimeUs?: number): Promise<{
    queued: boolean;
    sessionId: string;
    frameBytes: 1_920;
    presentationTimeUs: number;
  }>;
  finishNativeFaceTimeLiveAudioStream?(sessionId: string): Promise<{
    stopped: boolean;
    sessionId: string;
  }>;
  startNativeFaceTimeLiveVideoStream?(params: {
    sessionId: string;
    imageDescription: Buffer;
    frameDurationMs?: number;
    mediaEpochUnixMs?: number;
    rtpTimestampBase?: number;
  }): Promise<{
    started: boolean;
    sessionId: string;
    encoding: "hevc-annex-b";
    frameDurationMs: number;
    queueCapacityFrames: number;
    mediaEpochUnixMs: number;
    rtpTimestampBase: number;
  }>;
  pushNativeFaceTimeLiveVideoFrame?(sessionId: string, frame: Buffer, presentationTimeUs?: number): Promise<{
    queued: boolean;
    sessionId: string;
    frameBytes: number;
    presentationTimeUs: number;
  }>;
  finishNativeFaceTimeLiveVideoStream?(sessionId: string): Promise<{
    stopped: boolean;
    sessionId: string;
  }>;
  setNativeFaceTimeMediaStream?(params: {
    sessionId: string;
    enabled: boolean;
    audio?: boolean;
    video?: boolean;
    ttlSeconds?: number;
  }): Promise<FaceTimeNativeMediaStreamStatus>;
  close(): Promise<void>;
  on<K extends keyof EngineNotificationMap>(
    event: K,
    listener: (payload: EngineNotificationMap[K]) => void,
  ): this;
}

export class NativeEngine extends EventEmitter implements IMessageEngine {
  readonly rpc: NativeRpcClient;

  constructor(options: NativeRpcClientOptions) {
    super();
    this.rpc = new NativeRpcClient(options);
    this.rpc.on("notification", ({ method, params }: { method: string; params: unknown }) => {
      this.emit(method, params);
    });
    this.rpc.on("engine.log", (entry) => this.emit("engine.log", entry));
  }

  version(): Promise<EngineVersion> {
    return this.rpc.request("system.version");
  }

  initialize(params: InitializeParams): Promise<EngineSnapshot> {
    return this.rpc.request("system.initialize", params);
  }

  loginStart(appleId: string, password: string): Promise<LoginStartResult> {
    return this.rpc.request("account.login.start", { appleId, password });
  }

  login2faOptions(): Promise<{ phones: TwoFactorPhoneOption[] }> {
    return this.rpc.request("account.login.2fa.options");
  }

  loginRequestSms(phoneId: number): Promise<{ sent: boolean }> {
    return this.rpc.request("account.login.2fa.requestSms", { phoneId });
  }

  loginSubmit2fa(code: string): Promise<{ accepted: boolean }> {
    return this.rpc.request("account.login.submit2fa", { code });
  }

  loginFinish(): Promise<EngineSnapshot> {
    return this.rpc.request("account.login.finish");
  }

  iCloudKeychainDevices(): Promise<{ devices: ICloudKeychainDevice[] }> {
    return this.rpc.request("account.keychain.devices");
  }

  joinICloudKeychain(passcode: string, deviceIndex?: number): Promise<{ joined: boolean; detail: string }> {
    return this.rpc.request("account.keychain.join", {
      passcode,
      ...(deviceIndex === undefined ? {} : { deviceIndex }),
    });
  }

  iCloudWebStatus(): Promise<ICloudWebLoginStatus> {
    return this.rpc.request("icloud.web.status");
  }

  iCloudWebLoginStart(): Promise<ICloudWebLoginStatus> {
    return this.rpc.request("icloud.web.login.start");
  }

  iCloudWeb2faOptions(): Promise<{ phones: ICloudWebPhoneOption[] }> {
    return this.rpc.request("icloud.web.login.2fa.options");
  }

  iCloudWebRequestSms(phoneId: number, mode = "sms"): Promise<{ sent: boolean }> {
    return this.rpc.request("icloud.web.login.2fa.requestSms", { phoneId, mode });
  }

  iCloudWebSubmit2fa(
    code: string,
    phoneId?: number,
    mode = "sms",
  ): Promise<ICloudWebLoginStatus> {
    return this.rpc.request("icloud.web.login.submit2fa", {
      code,
      ...(phoneId === undefined ? {} : { phoneId, mode }),
    });
  }

  iCloudWebPreparePhotos(): Promise<ICloudWebLoginStatus> {
    return this.rpc.request("icloud.web.photos.prepare");
  }

  createICloudPhotoShare(params: {
    path: string;
    filename: string;
    mimeType: string;
    title?: string;
  }): Promise<FreshICloudPhotoShare> {
    return this.rpc.request("icloud.photos.share.create", params);
  }

  syncICloudContacts(): Promise<ICloudContactsSyncResult> {
    return this.rpc.request("icloud.contacts.sync");
  }

  migrateCredentialToFile(keyPath: string): Promise<{ migrated: boolean; credentialBackend: string }> {
    return this.rpc.request("account.credentials.migrateToFile", { keyPath });
  }

  logout(deregister = true): Promise<{ deregistered: boolean; credentialDeleted: boolean }> {
    return this.rpc.request("account.logout", { deregister });
  }

  inspectSavedRegistration(users: string): Promise<IdsRegistrationInspection> {
    return this.rpc.request("account.registration.inspect", { users });
  }

  startClient(): Promise<EngineSnapshot> {
    return this.rpc.request("client.start");
  }

  refreshRegistration(): Promise<{ registeredServices: number; snapshot: EngineSnapshot }> {
    return this.rpc.request("account.registration.refresh");
  }

  snapshot(): Promise<EngineSnapshot> {
    return this.rpc.request("system.snapshot");
  }

  health(): Promise<{ clientStarted: boolean; secondsSinceLastInbound: number }> {
    return this.rpc.request("system.health");
  }

  refreshFindMyFollowing(address?: string, findMyIds?: string[]): Promise<NativeFindMyFollow[]> {
    return this.rpc.request("findmy.following", { address, findMyIds });
  }

  sendMessage(params: SendMessageParams): Promise<{ guid: string }> {
    return this.rpc.request("message.send", params);
  }

  sendComponent(params: SendComponentParams): Promise<{ guid: string }> {
    return this.rpc.request("message.component.send", params);
  }

  setConversationBackground(params: SendConversationBackgroundParams): Promise<{ guid: string }> {
    return this.rpc.request("conversation.background.set", params);
  }

  syncCloudChats(continuationToken?: string): Promise<CloudChatsPage> {
    return this.rpc.request("cloud.sync.chats", { continuationToken });
  }

  syncCloudMessages(continuationToken?: string): Promise<CloudMessagesPage> {
    return this.rpc.request("cloud.sync.messages", { continuationToken });
  }

  syncCloudAttachments(continuationToken?: string): Promise<CloudAttachmentsPage> {
    return this.rpc.request("cloud.sync.attachments", { continuationToken });
  }

  syncFocusPeers(cachedZone?: string, continuationToken?: string): Promise<FocusPeersSyncPage> {
    return this.rpc.request("focus.sync", { cachedZone, continuationToken });
  }

  subscribeFocus(handles: string[]): Promise<{ subscribed: string[] }> {
    return this.rpc.request("focus.subscribe", { handles });
  }

  shareFocus(active: boolean, mode?: string): Promise<{ shared: boolean }> {
    return this.rpc.request("focus.share", { active, ...(mode ? { mode } : {}) });
  }

  sendReaction(params: SendReactionParams): Promise<{ guid: string }> {
    return this.rpc.request("reaction.send", params);
  }

  sendStickerReaction(params: SendStickerReactionParams): Promise<{ guid: string }> {
    return this.rpc.request("reaction.sticker.send", params);
  }

  updateStickerReaction(params: UpdateStickerReactionParams): Promise<{ guid: string }> {
    return this.rpc.request("reaction.sticker.update", params);
  }

  sendPollVote(params: SendPollVoteParams): Promise<{ guid: string }> {
    return this.rpc.request("poll.vote", params);
  }

  sendAttachment(params: SendAttachmentParams): Promise<{ guid: string }> {
    return this.rpc.request("attachment.send", params);
  }

  sendMultipartMessage(params: SendMultipartMessageParams): Promise<{ guid: string }> {
    return this.rpc.request("message.multipart.send", params);
  }

  renameGroup(params: SendGroupRenameParams): Promise<{ guid: string }> {
    return this.rpc.request("chat.rename", params);
  }

  changeGroupParticipants(params: SendGroupParticipantsParams): Promise<{ guid: string }> {
    return this.rpc.request("chat.participants.change", params);
  }

  leaveGroup(params: SendGroupLeaveParams): Promise<{ guid: string }> {
    return this.rpc.request("chat.leave", params);
  }

  setGroupIcon(params: SendGroupIconParams): Promise<{ guid: string }> {
    return this.rpc.request("chat.icon.set", params);
  }

  validateHandles(params: ValidateHandlesParams): Promise<{ available: string[] }> {
    return this.rpc.request("handle.validate", params);
  }

  lookupHandles(params: ValidateHandlesParams): Promise<IdsLookupResult> {
    return this.rpc.request("handle.lookup", params);
  }

  validateHandlesHttp(params: ValidateHandlesParams): Promise<{ available: string[] }> {
    return this.rpc.request("handle.validateHttp", params);
  }

  sendEdit(params: SendEditParams): Promise<{ guid: string }> {
    return this.rpc.request("message.edit", params);
  }

  sendUnsend(params: SendUnsendParams): Promise<{ guid: string }> {
    return this.rpc.request("message.unsend", params);
  }

  sendTyping(params: SendTypingParams): Promise<{ sent: boolean }> {
    return this.rpc.request("chat.typing", params);
  }

  sendReadReceipt(params: SendReadReceiptParams): Promise<{ sent: boolean }> {
    return this.rpc.request("chat.read", params);
  }

  sendMarkUnread(params: SendMarkUnreadParams): Promise<{ sent: boolean }> {
    return this.rpc.request("chat.unread", params);
  }

  sendNotify(params: SendNotifyParams): Promise<{ guid: string }> {
    return this.rpc.request("message.notify", params);
  }

  createFaceTimeSession(params: FaceTimeSessionCreateParams): Promise<FaceTimeSessionStart> {
    return this.rpc.request("facetime.session.create", params);
  }

  listFaceTimeSessions(): Promise<unknown> {
    return this.rpc.request("facetime.session.list");
  }

  leaveFaceTimeSession(sessionId: string): Promise<{ left: boolean; sessionId: string }> {
    return this.rpc.request("facetime.session.leave", { sessionId });
  }

  ringFaceTimeSession(sessionId: string, targets: string[]): Promise<{
    rang: boolean;
    sessionId: string;
    targets: string[];
  }> {
    return this.rpc.request("facetime.session.ring", { sessionId, targets });
  }

  confirmFaceTimeMediaJoined(sessionId: string): Promise<{
    confirmed: boolean;
    sessionId: string;
  }> {
    return this.rpc.request("facetime.session.mediaJoined", { sessionId });
  }

  createNativeFaceTimeMediaSession(params: {
    targets: string[];
    from?: string;
    audioPath: string;
    videoPath?: string;
    videoDescriptionPath?: string;
    videoFrameDurationMs?: number;
    ring?: boolean;
  }): Promise<FaceTimeNativeMediaStart> {
    return this.rpc.request("facetime.native.create", params);
  }

  startNativeFaceTimeMediaSession(sessionId: string): Promise<{
    started: boolean;
    sessionId: string;
    transport: "iblue-quickrelay";
  }> {
    return this.rpc.request("facetime.native.start", { sessionId });
  }

  nativeFaceTimeMediaStatus(sessionId: string): Promise<FaceTimeNativeMediaStatus> {
    return this.rpc.request("facetime.native.status", { sessionId });
  }

  listIncomingFaceTimeSessions(): Promise<FaceTimeIncomingSession[]> {
    return this.rpc.request("facetime.incoming.list");
  }

  answerIncomingFaceTimeSession(params: {
    sessionId: string;
    audioPath?: string;
    videoPath?: string;
    videoDescriptionPath?: string;
    videoFrameDurationMs?: number;
  }): Promise<FaceTimeIncomingSession> {
    return this.rpc.request("facetime.incoming.answer", params);
  }

  declineIncomingFaceTimeSession(sessionId: string): Promise<FaceTimeIncomingSession> {
    return this.rpc.request("facetime.incoming.decline", { sessionId });
  }

  createNativeFaceTimeLiveAudioSession(params: {
    targets: string[];
    from?: string;
    ring?: boolean;
  }): Promise<FaceTimeNativeLiveAudioStart> {
    return this.rpc.request("facetime.native.audio.create", params);
  }

  startNativeFaceTimeLiveAudioStream(sessionId: string, timing?: {
    mediaEpochUnixMs?: number;
    rtpTimestampBase?: number;
  }): Promise<{
    started: boolean;
    sessionId: string;
    frameBytes: 1_920;
    queueCapacityFrames: number;
    mediaEpochUnixMs: number;
    rtpTimestampBase: number;
  }> {
    return this.rpc.request("facetime.native.audio.start", { sessionId, ...timing });
  }

  pushNativeFaceTimeLiveAudioFrame(
    sessionId: string,
    frame: Buffer,
    presentationTimeUs?: number,
  ): Promise<{
    queued: boolean;
    sessionId: string;
    frameBytes: 1_920;
    presentationTimeUs: number;
  }> {
    return this.rpc.request("facetime.native.audio.push", {
      sessionId,
      dataBase64: frame.toString("base64"),
      ...(presentationTimeUs === undefined ? {} : { presentationTimeUs }),
    });
  }

  finishNativeFaceTimeLiveAudioStream(sessionId: string): Promise<{
    stopped: boolean;
    sessionId: string;
  }> {
    return this.rpc.request("facetime.native.audio.stop", { sessionId });
  }

  startNativeFaceTimeLiveVideoStream(params: {
    sessionId: string;
    imageDescription: Buffer;
    frameDurationMs?: number;
    mediaEpochUnixMs?: number;
    rtpTimestampBase?: number;
  }): Promise<{
    started: boolean;
    sessionId: string;
    encoding: "hevc-annex-b";
    frameDurationMs: number;
    queueCapacityFrames: number;
    mediaEpochUnixMs: number;
    rtpTimestampBase: number;
  }> {
    return this.rpc.request("facetime.native.video.start", {
      sessionId: params.sessionId,
      imageDescriptionBase64: params.imageDescription.toString("base64"),
      ...(params.frameDurationMs === undefined
        ? {}
        : { frameDurationMs: params.frameDurationMs }),
      ...(params.mediaEpochUnixMs === undefined
        ? {}
        : { mediaEpochUnixMs: params.mediaEpochUnixMs }),
      ...(params.rtpTimestampBase === undefined
        ? {}
        : { rtpTimestampBase: params.rtpTimestampBase }),
    });
  }

  pushNativeFaceTimeLiveVideoFrame(
    sessionId: string,
    frame: Buffer,
    presentationTimeUs?: number,
  ): Promise<{
    queued: boolean;
    sessionId: string;
    frameBytes: number;
    presentationTimeUs: number;
  }> {
    return this.rpc.request("facetime.native.video.push", {
      sessionId,
      dataBase64: frame.toString("base64"),
      ...(presentationTimeUs === undefined ? {} : { presentationTimeUs }),
    });
  }

  finishNativeFaceTimeLiveVideoStream(sessionId: string): Promise<{
    stopped: boolean;
    sessionId: string;
  }> {
    return this.rpc.request("facetime.native.video.stop", { sessionId });
  }

  setNativeFaceTimeMediaStream(params: {
    sessionId: string;
    enabled: boolean;
    audio?: boolean;
    video?: boolean;
    ttlSeconds?: number;
  }): Promise<FaceTimeNativeMediaStreamStatus> {
    return this.rpc.request("facetime.native.stream.set", params);
  }

  close(): Promise<void> {
    return this.rpc.close();
  }
}

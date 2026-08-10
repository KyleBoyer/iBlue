export const RPC_VERSION = "1" as const;

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: "2.0";
  method: string;
  params: T;
}

export interface PersistedAccount {
  username: string;
  hashedPasswordHex: string;
  pet: string;
  adsid: string;
  dsid: string;
  spdBase64: string;
}

export interface PersistedSession {
  version: 1;
  profile: string;
  deviceId?: string;
  apsState?: string;
  users?: string;
  identity?: string;
  /** Legacy plaintext credential record, accepted once for OS credential-store migration. */
  account?: PersistedAccount;
  accountUsername?: string;
  handles: string[];
  updatedAt: string;
}

export interface InitializeParams {
  deviceId?: string;
  apsState?: string;
  users?: string;
  identity?: string;
  account?: PersistedAccount;
  hardwareKey?: string;
}

export interface EngineVersion {
  protocolVersion: typeof RPC_VERSION;
  engine: string;
  platform: string;
  architecture: string;
  registrationBackend: string;
  registrationAvailable: boolean;
  registrationDetail: string | null;
  hardwareKeyRequired: boolean;
}

export interface EngineSnapshot {
  protocolVersion: typeof RPC_VERSION;
  deviceId: string;
  apsState: string;
  users?: string;
  identity?: string;
  accountUsername?: string;
  credentialBackend: "macos-keychain" | "windows-credential-manager" | "secret-service" | "encrypted-file" | "os-credential-store";
  idsMode: "normal" | "passive";
  handles: string[];
  clientStarted: boolean;
  secondsSinceLastInbound: number;
}

export interface IdsRegistrationServiceInspection {
  service: string;
  handles: string[];
  registeredAtEpochSeconds: number | null;
  heartbeatIntervalSeconds: number | null;
  secondsUntilReregister: number | null;
  renewalState: "active" | "due" | "unknown";
  certificateSha256: string;
  dataHashHex: string;
  keyMaterialAvailable: boolean;
}

export interface IdsRegistrationUserInspection {
  userIndex: number;
  userType: "apple" | "phone";
  protocolVersion: number;
  authKeyMaterialAvailable: boolean;
  missingRequiredServices: string[];
  services: IdsRegistrationServiceInspection[];
}

export interface IdsRegistrationInspection {
  mode: "offline";
  appleNetworkAccessed: false;
  accountCredentialAccessed: false;
  softwareKeystoreRead: true;
  savedStateSha256: string;
  userCount: number;
  sendingHandles: string[];
  requiredServices: string[];
  completeServiceBundle: boolean;
  allKeyMaterialAvailable: boolean;
  locallyUsableForMadrid: boolean;
  users: IdsRegistrationUserInspection[];
  warnings: string[];
}

export interface Conversation {
  participants: string[];
  groupName?: string;
  senderGuid?: string;
  isSms?: boolean;
}

export interface SendMessageParams {
  conversation: Conversation;
  text: string;
  from?: string;
  html?: string;
  subject?: string;
  effectId?: string;
  replyGuid?: string;
  replyPart?: string;
  scheduledMs?: number;
}

export interface SendReactionParams {
  conversation: Conversation;
  targetUuid: string;
  targetPart?: number;
  targetText?: string;
  reaction: "heart" | "like" | "dislike" | "laugh" | "emphasize" | "question" | "emoji";
  emoji?: string;
  remove?: boolean;
  from?: string;
}

export interface SendAttachmentParams {
  conversation: Conversation;
  path: string;
  mimeType: string;
  utiType: string;
  filename?: string;
  from?: string;
  replyGuid?: string;
  replyPart?: string;
  caption?: string;
  effectId?: string;
  isAudioMessage?: boolean;
}

export interface SendMultipartPart {
  partIndex: number;
  text?: string;
  mention?: string;
  path?: string;
  mimeType?: string;
  utiType?: string;
  filename?: string;
}

export interface SendMultipartMessageParams {
  conversation: Conversation;
  parts: SendMultipartPart[];
  from?: string;
  subject?: string;
  effectId?: string;
  replyGuid?: string;
  replyPart?: string;
  ddScan?: boolean;
}

export interface SendGroupRenameParams {
  conversation: Conversation;
  newName: string;
  from?: string;
}

export interface SendGroupParticipantsParams {
  conversation: Conversation;
  newParticipants: string[];
  groupVersion: number;
  from?: string;
}

export interface SendGroupLeaveParams {
  conversation: Conversation;
  groupVersion: number;
  from?: string;
}

export interface SendGroupIconParams {
  conversation: Conversation;
  groupVersion: number;
  path?: string;
  from?: string;
}

export interface ValidateHandlesParams {
  addresses: string[];
  from?: string;
}

export interface IdsLookupTarget {
  address: string;
  cacheEntryFresh: boolean;
  responseEntryReturned: boolean;
  identityCount: number;
  correlationIdentifierPresent: boolean;
}

export interface IdsLookupResult {
  available: string[];
  targets: IdsLookupTarget[];
  error: string | null;
  panicked: boolean;
  timedOut: boolean;
  /** Strict lookup invocations; never a per-target/bisection count. */
  attempts: number;
}

export interface SendEditParams {
  conversation: Conversation;
  targetUuid: string;
  targetPart?: number;
  text: string;
  from?: string;
}

export interface SendUnsendParams {
  conversation: Conversation;
  targetUuid: string;
  targetPart?: number;
  from?: string;
}

export interface SendTypingParams {
  conversation: Conversation;
  active: boolean;
  from?: string;
}

export interface SendReadReceiptParams {
  conversation: Conversation;
  forUuid: string;
  from?: string;
}

export interface SendConversationControlParams {
  conversation: Conversation;
  from?: string;
}

export interface SendMarkUnreadParams extends SendConversationControlParams {
  forUuid: string;
}

export interface SendNotifyParams extends SendConversationControlParams {
  forUuid: string;
}

export interface IncomingAttachment {
  mimeType: string;
  filename: string;
  utiType: string;
  size: number;
  isInline: boolean;
  dataBase64?: string;
  iris: boolean;
  isSticker?: boolean;
  /** Transcript supplied by Apple's iMessage attachment metadata. */
  audioTranscription?: string;
  mmcsDescriptorJson?: string;
}

export interface IncomingSharedProfile {
  displayName?: string;
  firstName?: string;
  lastName?: string;
  hasPoster: boolean;
  avatarBase64?: string;
}

export interface IncomingAppBalloon {
  bundleId?: string;
  appName?: string;
  url?: string;
  sessionId?: string;
  isLive: boolean;
  ldText?: string;
  imageTitle?: string;
  imageSubtitle?: string;
  caption?: string;
  subcaption?: string;
  secondarySubcaption?: string;
  tertiarySubcaption?: string;
}

export interface NativeFindMyLocation {
  latitude: number;
  longitude: number;
  altitude: number;
  horizontalAccuracy: number;
  verticalAccuracy: number;
  timestamp: number;
  isInaccurate: boolean;
  isOld?: boolean;
  formattedAddressLines: string[];
  locality?: string;
  stateCode?: string;
  countryCode?: string;
}

export interface NativeFindMyFollow {
  id: string;
  invitationAcceptedHandles: string[];
  invitationFromHandles: string[];
  expires: number;
  updateTimestamp: number;
  isFromMessages: boolean;
  locateInProgress: boolean;
  lastLocation?: NativeFindMyLocation;
}

export interface IncomingMessage {
  uuid: string;
  sender?: string;
  text?: string;
  subject?: string;
  participants: string[];
  groupName?: string;
  senderGuid?: string;
  timestampMs: number;
  isSms: boolean;
  isStoredMessage: boolean;
  verificationFailed?: boolean;
  attachments: IncomingAttachment[];
  tapback?: {
    type?: number;
    targetUuid?: string;
    targetPart?: number;
    emoji?: string;
    remove: boolean;
  };
  edit?: { targetUuid?: string; part?: number; text?: string };
  unsend?: { targetUuid?: string; part?: number };
  reply?: { guid?: string; part?: string };
  typing?: { active: boolean; appBundleId?: string };
  readReceipt?: boolean;
  delivered?: boolean;
  error?: { forUuid?: string; status?: number; message?: string };
  groupRename?: { name?: string };
  participantChange?: {
    participants: string[];
    groupVersion?: number;
    action?: "add" | "remove" | "leave";
    changedAddress?: string;
  };
  groupIconChange?: {
    cleared: boolean;
    dataBase64?: string;
    mimeType?: string;
    groupVersion?: number;
  };
  markUnread?: boolean;
  notifyAnyway?: boolean;
  effect?: string;
  html?: string;
  isVoice?: boolean;
  sharedProfile?: IncomingSharedProfile;
  appBalloon?: IncomingAppBalloon;
}

export interface EngineNotificationMap {
  "message.received": IncomingMessage;
  "account.stateChanged": { users: string; handles: string[] };
  "engine.log": { level: string; message: string };
}

export interface ApiEvent<T = unknown> {
  id: string;
  type: string;
  profile: string;
  occurredAt: string;
  data: T;
}

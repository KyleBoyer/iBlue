export type BlueBubblesStatus = 200 | 201 | 400 | 401 | 403 | 404 | 500 | 501 | 502 | 504;

export interface BlueBubblesErrorBody {
  type: string;
  message: string;
}

export interface BlueBubblesResponse<T = unknown> {
  status: BlueBubblesStatus;
  message: string;
  data?: T;
  metadata?: Record<string, unknown>;
  error?: BlueBubblesErrorBody;
}

export type IBlueContactSource = "profile-vcf" | "icloud-carddav" | "name-and-photo-sharing";

export interface IBlueContactSummary {
  displayName: string;
  firstName?: string;
  lastName?: string;
  nickname?: string;
  source: IBlueContactSource;
}

export interface IBlueContact extends IBlueContactSummary {
  address: string;
  service: "iMessage";
  hasAvatar: boolean;
  updatedAt: number;
}

export interface IBlueSharedLocation {
  latitude?: number;
  longitude?: number;
  label?: string;
  address?: string;
  url: string;
  isLive: boolean;
  sessionId?: string;
  bundleId?: string;
  findMyId?: string;
}

export interface IBlueSharedLocationRecord extends IBlueSharedLocation {
  messageGuid: string;
  chatGuid: string;
  sender: string | null;
  dateCreated: number;
}

export interface IBlueMessageFlair {
  /** Stable friendly API name, or "unknown" for an unrecognized Apple ID. */
  name: string;
  displayName: string;
  category: "bubble" | "screen" | "unknown";
  /** Apple's exact expressiveSendStyleId value. */
  effectId: string;
  known: boolean;
}

export type IBlueTextStyle = "bold" | "italic" | "underline" | "strikethrough";

export type IBlueTextEffect =
  | "big"
  | "small"
  | "shake"
  | "nod"
  | "explode"
  | "ripple"
  | "bloom"
  | "jitter";

export interface IBlueTextRun {
  /** NSRange-compatible [location, length] measured in UTF-16 code units. */
  range: [number, number];
  text: string;
  styles?: IBlueTextStyle[];
  effect?: IBlueTextEffect;
}

export interface IBlueAttributedText {
  text: string;
  /** Semantic transport HTML accepted by iBlue's outbound API. */
  html: string;
  rangeEncoding: "utf-16";
  runs: IBlueTextRun[];
}

export interface IBlueAttributedBodyRun {
  range: [number, number];
  attributes: Record<string, string | number | boolean | string[]>;
}

export interface IBlueAttributedBody {
  string: string;
  runs: IBlueAttributedBodyRun[];
}

export interface IBlueReaction {
  kind: "tapback" | "emoji" | "sticker";
  /** Legacy Tapback name, "emoji", or "sticker". */
  name: string;
  emoji?: string;
  isRemoval: boolean;
  targetGuid?: string;
  partIndex?: number;
  /** Sticker attachment GUIDs are populated after the media is persisted. */
  attachmentGuids?: string[];
  stickerSource?: "sticker" | "memoji" | "genmoji" | "unknown";
}

export interface IBlueAudioTranscription {
  text: string;
  /** iBlue preserves Apple's value and does not run speech recognition. */
  source: "apple";
}

export interface IBlueAppleMusicLink {
  storefront: string;
  resourceType: "song" | "album" | "playlist" | "artist" | "music-video" | "unknown";
  catalogId: string;
  albumId?: string;
  songId?: string;
}

export interface IBlueRichLink {
  provider: "apple-music" | "generic";
  originalUrl: string;
  url?: string;
  title?: string;
  summary?: string;
  artwork?: {
    attachmentGuid: string;
    mimeType: string;
  };
  appleMusic?: IBlueAppleMusicLink;
}

export type IBlueICloudShareVariantName = "original" | "medium" | "thumbnail";

export interface IBlueICloudShareSummary {
  provider: "icloud-photos";
  shareId: string;
  url: string;
  isLive: boolean;
  caption?: string;
  itemCount?: number;
  photoCount?: number;
  videoCount?: number;
  bundleId?: string;
}

export interface IBlueICloudShareVariant {
  mimeType: string;
  uti: string;
  totalBytes: number;
  width: number;
  height: number;
  /** Authenticated iBlue proxy path; Apple CDN credentials are never exposed. */
  downloadUrl?: string;
}

export interface IBlueICloudShareItem {
  guid: string;
  mediaType: "image" | "video" | "unknown";
  createdAt?: number;
  durationMs?: number;
  variants: Partial<Record<IBlueICloudShareVariantName, IBlueICloudShareVariant>>;
}

export interface IBlueICloudShare extends IBlueICloudShareSummary {
  startDate?: number;
  endDate?: number;
  createdAt?: number;
  expiresAt?: number;
  ownerDisplayName?: string;
  truncated: boolean;
  items: IBlueICloudShareItem[];
}

export interface IBlueMessageComponent {
  bundleId?: string;
  appName?: string;
  appId?: number;
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
  iconBase64?: string;
}

export interface IBlueConversationBackground {
  removed: boolean;
  preset?: string;
  colors?: string[];
  objectId?: string;
  url?: string;
  fileSize?: number;
  updatedAt: number;
}

export interface IBlueFocusStatus {
  handle: string;
  available: boolean;
  notificationsSilenced: boolean;
  /** Opaque, per-person Focus configuration UUID. Do not use as a portable mode name. */
  mode?: string;
  updatedAt: number;
}

export type IBlueMessageReceiptType = "delivered" | "read";

/**
 * Additive receipt evidence retained per sender. BlueBubbles' dateDelivered
 * and dateRead fields remain the first-observed compatibility summary.
 */
export interface IBlueMessageReceipt {
  id: number;
  messageGuid: string;
  chatGuid: string;
  type: IBlueMessageReceiptType;
  handle?: string;
  source: "live" | "compatibility-backfill";
  /** Apple event timestamp in Unix milliseconds. */
  eventAt: number;
  /** Local observation time; absent for rows reconstructed from compatibility columns. */
  observedAt?: number;
  verificationFailed?: boolean;
}

export interface IBluePollOption {
  identifier: string;
  text: string;
  attributedText?: string;
  creatorHandle?: string;
  canBeEdited?: boolean;
}

export interface IBluePollVote {
  optionIdentifier: string;
  participantHandle: string;
  /** Apple's server vote timestamp, preserved in its original numeric scale. */
  serverVoteTime?: number;
}

export interface IBluePoll {
  version: number;
  title: string;
  creatorHandle?: string;
  options: IBluePollOption[];
  votes: IBluePollVote[];
  sessionId?: string;
  bundleId?: string;
}

export interface IBluePollVoteUpdate {
  version: number;
  votes: IBluePollVote[];
  /** Participant whose complete selection set this event replaces. */
  participantHandle?: string;
  sessionId?: string;
  bundleId?: string;
}

export interface IBlueLiveLocation {
  source: "find-my";
  followId: string;
  address: string;
  acceptedHandles: string[];
  fromHandles: string[];
  isActive: boolean;
  isFromMessages: boolean;
  locatingInProgress: boolean;
  expiresAt: number | null;
  sharingUpdatedAt: number;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  horizontalAccuracy?: number;
  verticalAccuracy?: number;
  locationUpdatedAt?: number;
  isInaccurate?: boolean;
  isOld?: boolean;
  formattedAddress?: string;
  locality?: string;
  stateCode?: string;
  countryCode?: string;
}

export interface BlueBubblesHandle {
  originalROWID: number;
  address: string;
  service: string;
  country?: string;
  uncanonicalizedId?: string;
  iBlue?: {
    contact?: IBlueContactSummary;
  };
}

export interface BlueBubblesAttachment {
  originalROWID: number;
  guid: string;
  messages?: string[];
  data?: string | null;
  height?: number;
  width?: number;
  uti: string;
  mimeType: string;
  transferState?: number;
  totalBytes: number;
  isOutgoing?: boolean;
  transferName: string;
  isSticker?: boolean;
  hideAttachment?: boolean;
  originalGuid?: string;
  metadata?: Record<string, string | boolean | number> | null;
  hasLivePhoto?: boolean;
}

export interface BlueBubblesChat {
  originalROWID: number;
  guid: string;
  participants?: BlueBubblesHandle[];
  messages?: BlueBubblesMessage[];
  lastMessage?: BlueBubblesMessage;
  properties?: Record<string, unknown>[] | null;
  style: number;
  chatIdentifier: string;
  isArchived: boolean;
  isFiltered?: boolean;
  displayName: string;
  groupId?: string;
  lastAddressedHandle?: string | null;
  iBlue?: {
    background?: IBlueConversationBackground;
  };
}

export interface BlueBubblesMessage {
  originalROWID: number;
  tempGuid?: string;
  guid: string;
  text: string | null;
  attributedBody?: IBlueAttributedBody[] | null;
  messageSummaryInfo?: Record<string, unknown>[] | null;
  handle: BlueBubblesHandle | null;
  handleId: number;
  otherHandle: number;
  chats?: BlueBubblesChat[];
  attachments: BlueBubblesAttachment[];
  subject: string | null;
  country?: string | null;
  error: number;
  dateCreated: number | null;
  dateRead: number | null;
  dateDelivered: number | null;
  isDelivered: boolean;
  isFromMe: boolean;
  isDelayed?: boolean;
  isAutoReply?: boolean;
  isSystemMessage?: boolean;
  isServiceMessage?: boolean;
  isForward?: boolean;
  isArchived: boolean;
  hasDdResults?: boolean;
  cacheRoomnames?: string | null;
  isAudioMessage?: boolean;
  datePlayed?: number | null;
  itemType: number;
  groupTitle: string | null;
  groupActionType: number;
  isExpired?: boolean;
  balloonBundleId: string | null;
  associatedMessageGuid: string | null;
  associatedMessageType: string | null;
  /** iBlue extension: the arbitrary emoji used by a modern emoji Tapback. */
  associatedMessageEmoji?: string | null;
  expressiveSendStyleId: string | null;
  timeExpressiveSendPlayed?: number | null;
  replyToGuid?: string | null;
  isCorrupt?: boolean;
  isSpam?: boolean;
  threadOriginatorGuid?: string | null;
  threadOriginatorPart?: string | null;
  dateRetracted?: number | null;
  dateEdited?: number | null;
  partCount?: number | null;
  payloadData?: Record<string, unknown>[] | null;
  hasPayloadData?: boolean;
  wasDeliveredQuietly?: boolean;
  didNotifyRecipient?: boolean;
  shareStatus?: number | null;
  shareDirection?: number | null;
  iBlue?: {
    source: "ids";
    storedMessage?: boolean;
    senderVerificationFailed?: boolean;
    compatibilityNotes?: string[];
    senderContact?: IBlueContactSummary;
    sharedLocation?: IBlueSharedLocation;
    messageFlair?: IBlueMessageFlair;
    attributedText?: IBlueAttributedText;
    reaction?: IBlueReaction;
    audioTranscription?: IBlueAudioTranscription;
    richLink?: IBlueRichLink;
    icloudShare?: IBlueICloudShareSummary;
    poll?: IBluePoll;
    pollVote?: IBluePollVoteUpdate;
    component?: IBlueMessageComponent;
  };
}

export type BlueBubblesReaction =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question"
  | "-love"
  | "-like"
  | "-dislike"
  | "-laugh"
  | "-emphasize"
  | "-question";

export type IBlueReactionRequest = BlueBubblesReaction | "emoji" | "-emoji";

export interface BlueBubblesWebhook {
  id: number;
  url: string;
  events: string[];
  created?: number;
  updated?: number;
}

export type BlueBubblesScheduleInterval = "hourly" | "daily" | "weekly" | "monthly" | "yearly";

export interface BlueBubblesScheduledMessagePayload {
  chatGuid: string;
  message: string;
  method: string;
  selectedMessageGuid?: string;
  effectId?: string;
  subject?: string;
  attributedBody?: string;
  partIndex?: number;
}

export type BlueBubblesScheduledMessageSchedule =
  | { type: "once" }
  | {
      type: "recurring";
      interval: number;
      intervalType: BlueBubblesScheduleInterval;
    };

export type BlueBubblesScheduledMessageStatus = "pending" | "in-progress" | "complete" | "error";

export interface BlueBubblesScheduledMessage {
  id: number;
  type: "send-message";
  payload: BlueBubblesScheduledMessagePayload;
  scheduledFor: string;
  schedule: BlueBubblesScheduledMessageSchedule;
  status: BlueBubblesScheduledMessageStatus;
  error: string | null;
  sentAt: string | null;
  created: string;
}

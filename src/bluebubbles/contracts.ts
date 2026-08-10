export type BlueBubblesStatus = 200 | 201 | 400 | 401 | 403 | 404 | 500 | 501 | 504;

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

export type IBlueContactSource = "profile-vcf" | "name-and-photo-sharing";

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
}

export interface BlueBubblesMessage {
  originalROWID: number;
  tempGuid?: string;
  guid: string;
  text: string | null;
  attributedBody?: unknown[] | null;
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
    audioTranscription?: IBlueAudioTranscription;
    richLink?: IBlueRichLink;
    poll?: IBluePoll;
    pollVote?: IBluePollVoteUpdate;
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

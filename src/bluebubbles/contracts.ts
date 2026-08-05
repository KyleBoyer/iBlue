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

export interface BlueBubblesHandle {
  originalROWID: number;
  address: string;
  service: string;
  country?: string;
  uncanonicalizedId?: string;
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

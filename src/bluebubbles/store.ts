import { createHash, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  Conversation,
  IncomingAppBalloon,
  IncomingMessage,
  IncomingSharedProfile,
} from "../types.js";
import type {
  BlueBubblesAttachment,
  BlueBubblesChat,
  BlueBubblesHandle,
  BlueBubblesMessage,
  BlueBubblesScheduledMessage,
  BlueBubblesScheduledMessagePayload,
  BlueBubblesScheduledMessageSchedule,
  BlueBubblesWebhook,
  IBlueContact,
  IBlueContactSource,
  IBlueContactSummary,
  IBlueConversationBackground,
  IBlueFocusStatus,
  IBlueReaction,
  IBluePoll,
  IBluePollVote,
  IBlueRichLink,
  IBlueSharedLocation,
  IBlueSharedLocationRecord,
} from "./contracts.js";
import { attributedBodyFromText, parseAttributedText } from "./attributed-text.js";
import { contactAddressKey, type ContactInput } from "./contact.js";
import {
  chatIdentifier,
  deriveIncomingChatGuid,
  incomingParticipants,
  isIncomingGroup,
  stripTransport,
  toTransportAddress,
} from "./guid.js";
import { sharedLocationFromBalloon, sharedLocationFromMessageText } from "./location.js";
import { iCloudShareFromBalloon } from "./icloud-share.js";
import { messageFlairFromEffectId } from "./message-flair.js";
import { pollFromBalloon, pollVoteUpdateFromBalloon } from "./polls.js";
import {
  decodeRichLink,
  RICH_LINK_IMAGE_MIME,
  RICH_LINK_METADATA_MIME,
  richLinkArtworkFilename,
  richLinkArtworkUti,
} from "./rich-link.js";

interface MessageRow {
  rowid: number;
  guid: string;
  chat_guid: string;
  sender: string | null;
  text: string | null;
  subject: string | null;
  date_created: number;
  date_read: number | null;
  date_delivered: number | null;
  date_edited: number | null;
  date_retracted: number | null;
  is_from_me: number;
  is_delivered: number;
  error: number;
  associated_guid: string | null;
  associated_type: string | null;
  reply_guid: string | null;
  raw_json: string;
}

interface ChatRow {
  rowid: number;
  guid: string;
  style: number;
  identifier: string;
  display_name: string | null;
  group_id: string | null;
  participants_json: string;
  updated_at: number;
  group_version: number;
  icon_path: string | null;
  icon_mime_type: string | null;
}

interface AttachmentRow {
  rowid: number;
  guid: string;
  message_guid: string;
  mime_type: string;
  uti: string;
  transfer_name: string;
  total_bytes: number;
  file_path: string | null;
  is_outgoing: number;
  has_live_photo: number;
  is_sticker: number;
}

interface ContactRow {
  address_key: string;
  address: string;
  source: IBlueContactSource;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  avatar: Uint8Array | null;
  updated_at: number;
}

interface SharedLocationRow {
  message_guid: string;
  chat_guid: string;
  sender: string | null;
  date_created: number;
  latitude: number | null;
  longitude: number | null;
  label: string | null;
  address: string | null;
  url: string;
  is_live: number;
  session_id: string | null;
  bundle_id: string | null;
}

interface ConversationBackgroundRow {
  chat_guid: string;
  removed: number;
  preset: string | null;
  colors_json: string | null;
  object_id: string | null;
  url: string | null;
  file_size: number | null;
  updated_at: number;
}

interface FocusStatusRow {
  address_key: string;
  handle: string;
  available: number;
  mode: string | null;
  updated_at: number;
}

interface WebhookRow {
  id: number;
  url: string;
  events_json: string;
  created_at: number;
  updated_at: number;
}

interface WebhookDeliveryRow {
  id: number;
  webhook_id: number;
  url: string;
  event_type: string;
  payload_json: string;
  attempt_count: number;
  next_attempt_at: number;
  last_error: string | null;
  failed_at: number | null;
  created_at: number;
}

export interface PendingWebhookDelivery {
  id: number;
  webhookId: number;
  url: string;
  eventType: string;
  payload: unknown;
  attemptCount: number;
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
}

interface ScheduledMessageRow {
  id: number;
  type: "send-message";
  payload_json: string;
  scheduled_for: number;
  schedule_json: string;
  status: BlueBubblesScheduledMessage["status"];
  error: string | null;
  sent_at: number | null;
  created_at: number;
}

export interface QueryOptions {
  offset?: number;
  limit?: number;
  before?: number;
  after?: number;
  chatGuid?: string;
  sort?: "ASC" | "DESC";
  afterRowId?: number;
  throughRowId?: number;
}

export interface MessageCountOptions {
  after?: number;
  before?: number;
  chatGuid?: string;
  minRowId?: number;
  maxRowId?: number;
  isFromMe?: boolean;
  updated?: boolean;
}

function stableInt(value: string): number {
  const digest = createHash("sha256").update(value).digest();
  return (digest.readUInt32BE(0) & 0x7fffffff) || 1;
}

function attachmentGuid(messageGuid: string, index: number): string {
  return `iblue-attachment-${createHash("sha256").update(`${messageGuid}:${index}`).digest("hex").slice(0, 32)}`;
}

function reactionName(type: number | undefined, remove: boolean): string | null {
  if (type === 7) return remove ? "3007" : "sticker";
  if (type === 6) return remove ? "-emoji" : "emoji";
  const names = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const;
  const name = type === undefined ? undefined : names[type];
  if (!name) return null;
  return remove ? `-${name}` : name;
}

function iBlueReaction(
  tapback: IncomingMessage["tapback"],
  attachmentGuids: string[],
  stickerSource?: IBlueReaction["stickerSource"],
): IBlueReaction | undefined {
  if (!tapback || tapback.type === undefined) return undefined;
  const legacyNames = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const;
  const legacyName = legacyNames[tapback.type];
  const name = legacyName
    ?? (tapback.type === 6
      ? "emoji"
      : tapback.type === 7
        ? "sticker"
        : `unknown-${tapback.type}`);
  return {
    kind: tapback.type === 6 ? "emoji" : tapback.type === 7 ? "sticker" : "tapback",
    name,
    ...(tapback.emoji ? { emoji: tapback.emoji } : {}),
    isRemoval: tapback.remove,
    ...(tapback.targetUuid ? { targetGuid: tapback.targetUuid } : {}),
    ...(typeof tapback.targetPart === "number" ? { partIndex: tapback.targetPart } : {}),
    ...(attachmentGuids.length > 0 ? { attachmentGuids } : {}),
    ...(tapback.type === 7 ? { stickerSource: stickerSource ?? "unknown" } : {}),
  };
}

function incomingEventKey(message: IncomingMessage): string {
  const kind = message.typing
    ? `typing:${message.typing.active ? "start" : "stop"}`
    : message.edit
      ? "edit"
      : message.unsend
        ? "unsend"
        : message.tapback
          ? "tapback"
          : message.markUnread
            ? "mark-unread"
            : message.notifyAnyway
              ? "notify-anyway"
              : message.groupRename
                ? "group-rename"
                : message.participantChange
                  ? "participant-change"
                  : message.groupIconChange
                    ? "group-icon-change"
                    : message.conversationBackground
                      ? "conversation-background"
                    : "message";
  return `${kind}:${message.uuid.toLowerCase()}`;
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function changedParticipants(values: readonly string[], ownHandles: readonly string[]): string[] {
  const own = new Set(ownHandles.map((value) => stripTransport(value).toLowerCase()));
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const address = toTransportAddress(value);
    const key = stripTransport(address).toLowerCase();
    if (own.has(key) || seen.has(key)) return [];
    seen.add(key);
    return [address];
  });
}

function hardenDatabaseFiles(databasePath: string): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      chmodSync(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class BlueBubblesStore {
  readonly database: DatabaseSync;
  readonly attachmentRoot: string;

  #messageByGuid: StatementSync;
  #chatByGuid: StatementSync;
  #attachmentsByMessage: StatementSync;
  #contactByAddress: StatementSync;
  #locationByMessage: StatementSync;
  readonly #incomingClaimOwner = randomUUID();

  constructor(databasePath: string, attachmentRoot: string) {
    this.database = new DatabaseSync(databasePath);
    this.attachmentRoot = attachmentRoot;
    hardenDatabaseFiles(databasePath);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS chat (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        style INTEGER NOT NULL,
        identifier TEXT NOT NULL,
        display_name TEXT,
        group_id TEXT,
        participants_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL,
        group_version INTEGER NOT NULL DEFAULT 0,
        icon_path TEXT,
        icon_mime_type TEXT
      );
      CREATE TABLE IF NOT EXISTS message (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        chat_guid TEXT NOT NULL REFERENCES chat(guid),
        sender TEXT,
        text TEXT,
        subject TEXT,
        date_created INTEGER NOT NULL,
        date_read INTEGER,
        date_delivered INTEGER,
        date_edited INTEGER,
        date_retracted INTEGER,
        is_from_me INTEGER NOT NULL DEFAULT 0,
        is_delivered INTEGER NOT NULL DEFAULT 0,
        error INTEGER NOT NULL DEFAULT 0,
        associated_guid TEXT,
        associated_type TEXT,
        reply_guid TEXT,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS message_chat_date ON message(chat_guid, date_created DESC);
      CREATE TABLE IF NOT EXISTS incoming_event (
        event_key TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        owner TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS attachment (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        message_guid TEXT NOT NULL REFERENCES message(guid) ON DELETE CASCADE,
        mime_type TEXT NOT NULL,
        uti TEXT NOT NULL,
        transfer_name TEXT NOT NULL,
        total_bytes INTEGER NOT NULL,
        file_path TEXT,
        is_outgoing INTEGER NOT NULL DEFAULT 0,
        has_live_photo INTEGER NOT NULL DEFAULT 0,
        is_sticker INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS contact (
        address_key TEXT NOT NULL,
        address TEXT NOT NULL,
        source TEXT NOT NULL,
        display_name TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        nickname TEXT,
        avatar BLOB,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(address_key, source)
      );
      CREATE INDEX IF NOT EXISTS contact_display_name ON contact(display_name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS conversation_background (
        chat_guid TEXT PRIMARY KEY REFERENCES chat(guid) ON DELETE CASCADE,
        removed INTEGER NOT NULL DEFAULT 0,
        preset TEXT,
        colors_json TEXT,
        object_id TEXT,
        url TEXT,
        file_size INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shared_location (
        message_guid TEXT PRIMARY KEY REFERENCES message(guid) ON DELETE CASCADE,
        latitude REAL,
        longitude REAL,
        label TEXT,
        address TEXT,
        url TEXT NOT NULL,
        is_live INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        bundle_id TEXT
      );
      CREATE TABLE IF NOT EXISTS focus_status (
        address_key TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        available INTEGER NOT NULL,
        mode TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhook (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        events_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(url)
      );
      CREATE TABLE IF NOT EXISTS webhook_delivery (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id INTEGER NOT NULL REFERENCES webhook(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        failed_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS webhook_delivery_due
        ON webhook_delivery(failed_at, next_attempt_at, webhook_id, id);
      CREATE TABLE IF NOT EXISTS scheduled_message (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL,
        schedule_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        sent_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scheduled_message_due
        ON scheduled_message(status, scheduled_for);
    `);
    const attachmentColumns = this.database.prepare("PRAGMA table_info(attachment)").all() as unknown as Array<{ name: string }>;
    if (!attachmentColumns.some((column) => column.name === "is_sticker")) {
      this.database.exec("ALTER TABLE attachment ADD COLUMN is_sticker INTEGER NOT NULL DEFAULT 0");
    }
    const chatColumns = this.database.prepare("PRAGMA table_info(chat)").all() as unknown as Array<{ name: string }>;
    if (!chatColumns.some((column) => column.name === "group_version")) {
      this.database.exec("ALTER TABLE chat ADD COLUMN group_version INTEGER NOT NULL DEFAULT 0");
    }
    if (!chatColumns.some((column) => column.name === "icon_path")) {
      this.database.exec("ALTER TABLE chat ADD COLUMN icon_path TEXT");
    }
    if (!chatColumns.some((column) => column.name === "icon_mime_type")) {
      this.database.exec("ALTER TABLE chat ADD COLUMN icon_mime_type TEXT");
    }
    const conversationBackgroundColumns = this.database.prepare(
      "PRAGMA table_info(conversation_background)",
    ).all() as unknown as Array<{ name: string }>;
    if (!conversationBackgroundColumns.some((column) => column.name === "preset")) {
      this.database.exec("ALTER TABLE conversation_background ADD COLUMN preset TEXT");
    }
    if (!conversationBackgroundColumns.some((column) => column.name === "colors_json")) {
      this.database.exec("ALTER TABLE conversation_background ADD COLUMN colors_json TEXT");
    }
    const incomingEventColumns = this.database.prepare("PRAGMA table_info(incoming_event)").all() as unknown as Array<{ name: string }>;
    if (!incomingEventColumns.some((column) => column.name === "owner")) {
      // Rows written by the brief pre-owner development schema represented
      // successfully observed events, so migrate them as completed.
      this.database.exec("ALTER TABLE incoming_event ADD COLUMN owner TEXT NOT NULL DEFAULT ''");
    }
    if (!incomingEventColumns.some((column) => column.name === "completed")) {
      this.database.exec("ALTER TABLE incoming_event ADD COLUMN completed INTEGER NOT NULL DEFAULT 1");
    }
    hardenDatabaseFiles(databasePath);
    this.#messageByGuid = this.database.prepare("SELECT * FROM message WHERE guid = ?");
    this.#chatByGuid = this.database.prepare("SELECT * FROM chat WHERE guid = ?");
    this.#attachmentsByMessage = this.database.prepare(
      "SELECT * FROM attachment WHERE message_guid = ? ORDER BY rowid ASC",
    );
    this.#contactByAddress = this.database.prepare(`
      SELECT * FROM contact WHERE address_key = ?
      ORDER BY CASE source WHEN 'profile-vcf' THEN 0 WHEN 'icloud-carddav' THEN 1 ELSE 2 END,
        updated_at DESC
      LIMIT 1
    `);
    this.#locationByMessage = this.database.prepare(`
      SELECT shared_location.*, message.chat_guid, message.sender, message.date_created
      FROM shared_location
      JOIN message ON message.guid = shared_location.message_guid
      WHERE shared_location.message_guid = ?
    `);
    this.backfillStaticLocationMessages();
  }

  close(): void {
    this.database.close();
  }

  /**
   * Claim one non-receipt IDS envelope before asynchronous attachment/event
   * handling. APNs reconnect and stored-message replay can repeat an envelope;
   * this durable key keeps webhooks and Socket.IO events idempotent across
   * process restarts. Call releaseIncomingEvent if processing fails.
   */
  claimIncomingEvent(message: IncomingMessage): string | undefined {
    const key = incomingEventKey(message);
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO incoming_event (event_key, received_at, owner, completed)
      VALUES (?, ?, ?, 0)
    `).run(key, Date.now(), this.#incomingClaimOwner);
    if (Number(result.changes) > 0) return key;

    const existing = this.database.prepare(`
      SELECT owner, completed FROM incoming_event WHERE event_key = ?
    `).get(key) as { owner: string; completed: number } | undefined;
    if (!existing || existing.completed || existing.owner === this.#incomingClaimOwner) {
      return undefined;
    }
    // A different store owner means the previous process ended while this
    // event was incomplete. Atomically reclaim it for the current process.
    const reclaimed = this.database.prepare(`
      UPDATE incoming_event SET owner = ?, received_at = ?
      WHERE event_key = ? AND completed = 0 AND owner = ?
    `).run(this.#incomingClaimOwner, Date.now(), key, existing.owner);
    return Number(reclaimed.changes) > 0 ? key : undefined;
  }

  completeIncomingEvent(key: string): void {
    this.database.prepare(`
      UPDATE incoming_event SET completed = 1
      WHERE event_key = ? AND owner = ? AND completed = 0
    `).run(key, this.#incomingClaimOwner);
  }

  releaseIncomingEvent(key: string): void {
    this.database.prepare(`
      DELETE FROM incoming_event WHERE event_key = ? AND owner = ? AND completed = 0
    `).run(key, this.#incomingClaimOwner);
  }

  async ingestIncoming(
    message: IncomingMessage,
    ownHandles: readonly string[],
  ): Promise<BlueBubblesMessage> {
    const chatGuid = deriveIncomingChatGuid(message, ownHandles);
    const isFromMe = Boolean(
      message.sender &&
        ownHandles.some(
          (handle) => stripTransport(handle).toLowerCase() === stripTransport(message.sender!).toLowerCase(),
        ),
    );
    const participants = message.participantChange
      ? changedParticipants(message.participantChange.participants, ownHandles)
      : incomingParticipants(message, ownHandles);
    const group = isIncomingGroup(message, ownHandles);
    this.upsertChat(chatGuid, {
      participants,
      ...(message.groupName ? { groupName: message.groupName } : {}),
      ...(group && message.senderGuid ? { senderGuid: message.senderGuid } : {}),
      isSms: message.isSms,
    });
    if (message.participantChange?.groupVersion !== undefined) {
      this.setGroupVersion(chatGuid, message.participantChange.groupVersion);
    }
    if (message.groupIconChange?.groupVersion !== undefined) {
      this.setGroupVersion(chatGuid, message.groupIconChange.groupVersion);
    }
    if (message.groupIconChange?.cleared) {
      await this.persistGroupIcon(chatGuid, undefined, undefined, message.groupIconChange.groupVersion);
    } else if (message.groupIconChange?.dataBase64) {
      await this.persistGroupIcon(
        chatGuid,
        Buffer.from(message.groupIconChange.dataBase64, "base64"),
        message.groupIconChange.mimeType ?? "image/jpeg",
        message.groupIconChange.groupVersion,
      );
    }

    if (message.edit?.targetUuid) {
      this.database
        .prepare("UPDATE message SET text = ?, date_edited = ?, raw_json = ? WHERE guid = ?")
        .run(message.edit.text ?? null, message.timestampMs, JSON.stringify(message), message.edit.targetUuid);
      return this.getMessage(message.edit.targetUuid) ?? this.insertIncomingRecord(message, chatGuid, isFromMe);
    }
    if (message.unsend?.targetUuid) {
      this.database
        .prepare("UPDATE message SET date_retracted = ?, raw_json = ? WHERE guid = ?")
        .run(message.timestampMs, JSON.stringify(message), message.unsend.targetUuid);
      return this.getMessage(message.unsend.targetUuid) ?? this.insertIncomingRecord(message, chatGuid, isFromMe);
    }

    const output = this.insertIncomingRecord(message, chatGuid, isFromMe);
    this.persistSharedLocation(message);
    await this.persistAttachments(message);
    return this.getMessage(output.guid) ?? output;
  }

  private insertIncomingRecord(
    message: IncomingMessage,
    chatGuid: string,
    isFromMe: boolean,
  ): BlueBubblesMessage {
    const associatedType = message.tapback
      ? pollVoteUpdateFromBalloon(message.appBalloon)
        ? "poll-vote"
        : reactionName(message.tapback.type, message.tapback.remove)
      : null;
    this.database
      .prepare(`
        INSERT INTO message (
          guid, chat_guid, sender, text, subject, date_created, is_from_me,
          is_delivered, error, associated_guid, associated_type, reply_guid, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guid) DO UPDATE SET
          text=excluded.text, subject=excluded.subject,
          is_delivered=MAX(message.is_delivered, excluded.is_delivered),
          error=excluded.error, raw_json=excluded.raw_json
      `)
      .run(
        message.uuid,
        chatGuid,
        message.sender ?? null,
        message.text ?? null,
        message.subject ?? null,
        message.timestampMs || Date.now(),
        isFromMe ? 1 : 0,
        message.delivered ? 1 : 0,
        message.error?.status ?? 0,
        message.tapback?.targetUuid ?? null,
        associatedType,
        message.reply?.guid ?? null,
        JSON.stringify(message),
      );
    const result = this.getMessage(message.uuid);
    if (!result) throw new Error(`failed to persist incoming message ${message.uuid}`);
    return result;
  }

  async persistAttachments(message: IncomingMessage): Promise<void> {
    if (message.attachments.length === 0) return;
    const directory = join(this.attachmentRoot, message.uuid.replace(/[^a-zA-Z0-9._-]/g, "_"));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [index, attachment] of message.attachments.entries()) {
      const guid = attachmentGuid(message.uuid, index);
      let path: string | null = null;
      if (attachment.dataBase64) {
        const name = basename(attachment.filename || `attachment-${index}`);
        path = join(directory, name);
        await writeFile(path, Buffer.from(attachment.dataBase64, "base64"), { mode: 0o600 });
      }
      this.database
        .prepare(`
          INSERT INTO attachment (
            guid, message_guid, mime_type, uti, transfer_name, total_bytes,
            file_path, is_outgoing, has_live_photo, is_sticker
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          ON CONFLICT(guid) DO UPDATE SET
            file_path=excluded.file_path, total_bytes=excluded.total_bytes,
            is_sticker=excluded.is_sticker
        `)
        .run(
          guid,
          message.uuid,
          attachment.mimeType,
          attachment.utiType,
          attachment.filename,
          attachment.size,
          path,
          attachment.iris ? 1 : 0,
          attachment.isSticker ? 1 : 0,
        );
    }
  }

  insertOutgoing(params: {
    guid: string;
    tempGuid?: string;
    chatGuid: string;
    text?: string;
    subject?: string;
    timestamp?: number;
    associatedGuid?: string;
    associatedType?: string;
    replyGuid?: string;
    replyPart?: string;
    effect?: string;
    html?: string;
    tapback?: NonNullable<IncomingMessage["tapback"]>;
    isVoice?: boolean;
    partCount?: number;
    appBalloon?: IncomingAppBalloon;
    pollParticipantHandle?: string;
    richLink?: IBlueRichLink;
    stickerSource?: Exclude<IBlueReaction["stickerSource"], "unknown">;
  }): BlueBubblesMessage {
    const conversation = this.conversationForChat(params.chatGuid);
    if (!conversation) throw new Error(`chat does not exist: ${params.chatGuid}`);
    this.database
      .prepare(`
        INSERT INTO message (
          guid, chat_guid, text, subject, date_created, is_from_me, is_delivered,
          associated_guid, associated_type, reply_guid, raw_json
        ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
        ON CONFLICT(guid) DO NOTHING
      `)
      .run(
        params.guid,
        params.chatGuid,
        params.text ?? null,
        params.subject ?? null,
        params.timestamp ?? Date.now(),
        params.associatedGuid ?? null,
        params.associatedType ?? null,
        params.replyGuid ?? null,
        JSON.stringify({
          ...(params.tempGuid ? { tempGuid: params.tempGuid } : {}),
          ...(params.effect ? { effect: params.effect } : {}),
          ...(params.html ? { html: params.html } : {}),
          ...(params.tapback ? { tapback: params.tapback } : {}),
          ...(params.isVoice ? { isVoice: true } : {}),
          ...(params.replyGuid
            ? { reply: { guid: params.replyGuid, part: params.replyPart ?? "0" } }
            : {}),
          ...(params.partCount === undefined ? {} : { partCount: params.partCount }),
          ...(params.appBalloon ? { appBalloon: params.appBalloon } : {}),
          ...(params.pollParticipantHandle
            ? { pollParticipantHandle: params.pollParticipantHandle }
            : {}),
          ...(params.richLink ? { richLink: params.richLink } : {}),
          ...(params.stickerSource ? { stickerSource: params.stickerSource } : {}),
        }),
      );
    const message = this.getMessage(params.guid);
    if (!message) throw new Error(`failed to persist outgoing message ${params.guid}`);
    if (params.tempGuid) message.tempGuid = params.tempGuid;
    return message;
  }

  async persistOutgoingAttachment(params: {
    messageGuid: string;
    sourcePath: string;
    filename: string;
    mimeType: string;
    utiType: string;
    isSticker?: boolean;
  }): Promise<BlueBubblesMessage> {
    return this.persistOutgoingAttachments({
      messageGuid: params.messageGuid,
      attachments: [params],
    });
  }

  async persistOutgoingAttachments(params: {
    messageGuid: string;
    attachments: Array<{
      sourcePath: string;
      filename: string;
      mimeType: string;
      utiType: string;
      isSticker?: boolean;
    }>;
  }): Promise<BlueBubblesMessage> {
    const directory = join(this.attachmentRoot, params.messageGuid.replace(/[^a-zA-Z0-9._-]/g, "_"));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [index, attachment] of params.attachments.entries()) {
      const transferName = basename(attachment.filename);
      const storedName = params.attachments.length === 1 ? transferName : `${index}-${transferName}`;
      const path = join(directory, storedName);
      await copyFile(attachment.sourcePath, path);
      const size = (await stat(path)).size;
      const guid = attachmentGuid(params.messageGuid, index);
      this.database
        .prepare(`
          INSERT INTO attachment (
            guid, message_guid, mime_type, uti, transfer_name, total_bytes,
            file_path, is_outgoing, has_live_photo, is_sticker
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
          ON CONFLICT(guid) DO UPDATE SET
            mime_type=excluded.mime_type,
            uti=excluded.uti,
            transfer_name=excluded.transfer_name,
            file_path=excluded.file_path,
            total_bytes=excluded.total_bytes,
            is_sticker=excluded.is_sticker
        `)
        .run(
          guid,
          params.messageGuid,
          attachment.mimeType,
          attachment.utiType,
          transferName,
          size,
          path,
          attachment.isSticker ? 1 : 0,
        );
    }
    const message = this.getMessage(params.messageGuid);
    if (!message) throw new Error(`failed to reload attachment message ${params.messageGuid}`);
    return message;
  }

  ensureDirectChat(chatGuid: string, conversation: Conversation): void {
    this.upsertChat(chatGuid, conversation);
  }

  upsertChat(chatGuid: string, conversation: Conversation): void {
    const group = chatGuid.includes(";+;");
    this.database
      .prepare(`
        INSERT INTO chat (guid, style, identifier, display_name, group_id, participants_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guid) DO UPDATE SET
          display_name=COALESCE(excluded.display_name, chat.display_name),
          participants_json=excluded.participants_json,
          updated_at=excluded.updated_at
      `)
      .run(
        chatGuid,
        group ? 43 : 45,
        chatIdentifier(chatGuid),
        conversation.groupName ?? null,
        group ? conversation.senderGuid ?? chatIdentifier(chatGuid) : null,
        JSON.stringify(conversation.participants.map(stripTransport)),
        Date.now(),
      );
  }

  conversationForChat(chatGuid: string): Conversation | undefined {
    const row = this.#chatByGuid.get(chatGuid) as unknown as ChatRow | undefined;
    if (!row) return undefined;
    return {
      participants: safeJsonArray(row.participants_json).map((value) =>
        value.includes("@") ? `mailto:${value}` : `tel:${value}`,
      ),
      ...(row.display_name ? { groupName: row.display_name } : {}),
      ...(row.group_id ? { senderGuid: row.group_id } : {}),
      isSms: chatGuid.startsWith("SMS;"),
    };
  }

  updateChatDisplayName(chatGuid: string, displayName: string): void {
    this.database
      .prepare("UPDATE chat SET display_name = ?, updated_at = ? WHERE guid = ?")
      .run(displayName, Date.now(), chatGuid);
  }

  updateChatParticipants(chatGuid: string, participants: readonly string[]): void {
    this.database
      .prepare("UPDATE chat SET participants_json = ?, updated_at = ? WHERE guid = ?")
      .run(JSON.stringify(participants.map(stripTransport)), Date.now(), chatGuid);
  }

  reserveGroupVersion(chatGuid: string): number {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#chatByGuid.get(chatGuid) as unknown as ChatRow | undefined;
      if (!row) throw new Error(`chat does not exist: ${chatGuid}`);
      const version = Math.max(row.group_version + 1, Math.floor(Date.now() / 1000));
      this.database
        .prepare("UPDATE chat SET group_version = ?, updated_at = ? WHERE guid = ?")
        .run(version, Date.now(), chatGuid);
      this.database.exec("COMMIT");
      return version;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  setGroupVersion(chatGuid: string, version: number): void {
    if (!Number.isSafeInteger(version) || version < 0) return;
    this.database
      .prepare("UPDATE chat SET group_version = MAX(group_version, ?), updated_at = ? WHERE guid = ?")
      .run(version, Date.now(), chatGuid);
  }

  async persistGroupIcon(
    chatGuid: string,
    data?: Buffer,
    mimeType?: string,
    groupVersion?: number,
  ): Promise<void> {
    if (groupVersion !== undefined) this.setGroupVersion(chatGuid, groupVersion);
    const previous = this.#chatByGuid.get(chatGuid) as unknown as ChatRow | undefined;
    if (!previous) throw new Error(`chat does not exist: ${chatGuid}`);
    const directory = join(this.attachmentRoot, "group-icons");
    const path = join(directory, `${createHash("sha256").update(chatGuid).digest("hex")}.bin`);
    if (data) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path, data, { mode: 0o600 });
      this.database
        .prepare("UPDATE chat SET icon_path = ?, icon_mime_type = ?, updated_at = ? WHERE guid = ?")
        .run(path, mimeType ?? "image/jpeg", Date.now(), chatGuid);
      return;
    }
    this.database
      .prepare("UPDATE chat SET icon_path = NULL, icon_mime_type = NULL, updated_at = ? WHERE guid = ?")
      .run(Date.now(), chatGuid);
    if (previous.icon_path) await rm(previous.icon_path, { force: true });
  }

  getGroupIcon(chatGuid: string): { path: string; mimeType: string } | undefined {
    const row = this.#chatByGuid.get(chatGuid) as unknown as ChatRow | undefined;
    return row?.icon_path
      ? { path: row.icon_path, mimeType: row.icon_mime_type ?? "image/jpeg" }
      : undefined;
  }

  async persistConversationBackgroundPayload(
    chatGuid: string,
    messageGuid: string,
    payloadBase64: string,
  ): Promise<string | undefined> {
    const data = safeBase64(payloadBase64);
    if (!data) return undefined;
    const directory = join(
      this.attachmentRoot,
      "conversation-backgrounds",
      createHash("sha256").update(chatGuid).digest("hex"),
    );
    const safeMessageGuid = messageGuid.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = join(directory, `${safeMessageGuid}.zip`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, data, { mode: 0o600 });
    return path;
  }

  getMessage(guid: string, includeChat = true): BlueBubblesMessage | undefined {
    const row = this.#messageByGuid.get(guid) as unknown as MessageRow | undefined;
    return row ? this.serializeMessage(row, includeChat) : undefined;
  }

  getPoll(messageGuid: string): IBluePoll | undefined {
    const row = this.#messageByGuid.get(messageGuid) as unknown as MessageRow | undefined;
    return row ? this.pollForRow(row) : undefined;
  }

  queryMessages(options: QueryOptions = {}): { messages: BlueBubblesMessage[]; total: number } {
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    if (options.chatGuid) {
      clauses.push("chat_guid = ?");
      values.push(options.chatGuid);
    }
    if (options.after !== undefined) {
      clauses.push("date_created >= ?");
      values.push(options.after);
    }
    if (options.before !== undefined) {
      clauses.push("date_created <= ?");
      values.push(options.before);
    }
    if (options.afterRowId !== undefined) {
      clauses.push("rowid > ?");
      values.push(options.afterRowId);
    }
    if (options.throughRowId !== undefined) {
      clauses.push("rowid <= ?");
      values.push(options.throughRowId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const count = this.database.prepare(`SELECT COUNT(*) AS total FROM message ${where}`).get(...values) as {
      total: number;
    };
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const offset = Math.max(options.offset ?? 0, 0);
    const sort = options.sort === "ASC" ? "ASC" : "DESC";
    const rows = this.database
      .prepare(`SELECT * FROM message ${where} ORDER BY date_created ${sort}, rowid ${sort} LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as unknown as MessageRow[];
    return {
      messages: rows.map((row) => this.serializeMessage(row)),
      total: Number(count.total),
    };
  }

  countMessages(options: MessageCountOptions = {}): number {
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    if (options.chatGuid) {
      clauses.push("chat_guid = ?");
      values.push(options.chatGuid);
    }
    if (options.minRowId !== undefined) {
      clauses.push("rowid >= ?");
      values.push(options.minRowId);
    }
    if (options.maxRowId !== undefined) {
      clauses.push("rowid <= ?");
      values.push(options.maxRowId);
    }
    if (options.isFromMe) clauses.push("is_from_me = 1");
    if (options.updated && (options.after !== undefined || options.before !== undefined)) {
      const updateColumns = ["date_delivered", "date_read", "date_edited", "date_retracted"];
      const alternatives: string[] = [];
      for (const column of updateColumns) {
        const bounds: string[] = [];
        if (options.after !== undefined) {
          bounds.push(`${column} >= ?`);
          values.push(options.after);
        }
        if (options.before !== undefined) {
          bounds.push(`${column} <= ?`);
          values.push(options.before);
        }
        alternatives.push(`(${bounds.join(" AND ")})`);
      }
      clauses.push(`(${alternatives.join(" OR ")})`);
    } else {
      if (options.after !== undefined) {
        clauses.push("date_created >= ?");
        values.push(options.after);
      }
      if (options.before !== undefined) {
        clauses.push("date_created <= ?");
        values.push(options.before);
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const row = this.database.prepare(`SELECT COUNT(*) AS total FROM message ${where}`).get(...values) as {
      total: number;
    };
    return Number(row.total);
  }

  countChats(): { total: number; breakdown: Record<string, number> } {
    const rows = this.database.prepare("SELECT guid, COUNT(*) AS total FROM chat GROUP BY substr(guid, 1, instr(guid, ';') - 1)").all() as unknown as Array<{
      guid: string;
      total: number;
    }>;
    const breakdown: Record<string, number> = {};
    for (const row of rows) breakdown[row.guid || "iMessage"] = Number(row.total);
    return { total: Object.values(breakdown).reduce((sum, count) => sum + count, 0), breakdown };
  }

  countAttachments(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS total FROM attachment").get() as { total: number };
    return Number(row.total);
  }

  mediaTotals(): { images: number; videos: number; locations: number } {
    const rows = this.database.prepare("SELECT mime_type, uti FROM attachment").all() as unknown as Array<{
      mime_type: string;
      uti: string;
    }>;
    const totals = { images: 0, videos: 0, locations: 0 };
    for (const row of rows) {
      const category = mediaCategory(row.mime_type, row.uti);
      if (category !== "other") totals[category] += 1;
    }
    const locations = this.database.prepare("SELECT COUNT(*) AS total FROM shared_location").get() as {
      total: number;
    };
    totals.locations += Number(locations.total);
    return totals;
  }

  mediaTotalsByChat(): Array<{
    chatGuid: string;
    groupName: string | null;
    totals: { images: number; videos: number; locations: number };
  }> {
    const rows = this.database.prepare(`
      SELECT message.chat_guid, chat.display_name, attachment.mime_type, attachment.uti
      FROM attachment
      JOIN message ON message.guid = attachment.message_guid
      JOIN chat ON chat.guid = message.chat_guid
      ORDER BY message.chat_guid
    `).all() as unknown as Array<{
      chat_guid: string;
      display_name: string | null;
      mime_type: string;
      uti: string;
    }>;
    const result = new Map<string, {
      chatGuid: string;
      groupName: string | null;
      totals: { images: number; videos: number; locations: number };
    }>();
    for (const row of rows) {
      let entry = result.get(row.chat_guid);
      if (!entry) {
        entry = {
          chatGuid: row.chat_guid,
          groupName: row.display_name,
          totals: { images: 0, videos: 0, locations: 0 },
        };
        result.set(row.chat_guid, entry);
      }
      const category = mediaCategory(row.mime_type, row.uti);
      if (category !== "other") entry.totals[category] += 1;
    }
    const locationRows = this.database.prepare(`
      SELECT message.chat_guid, chat.display_name, COUNT(*) AS total
      FROM shared_location
      JOIN message ON message.guid = shared_location.message_guid
      JOIN chat ON chat.guid = message.chat_guid
      GROUP BY message.chat_guid, chat.display_name
    `).all() as unknown as Array<{
      chat_guid: string;
      display_name: string | null;
      total: number;
    }>;
    for (const row of locationRows) {
      let entry = result.get(row.chat_guid);
      if (!entry) {
        entry = {
          chatGuid: row.chat_guid,
          groupName: row.display_name,
          totals: { images: 0, videos: 0, locations: 0 },
        };
        result.set(row.chat_guid, entry);
      }
      entry.totals.locations += Number(row.total);
    }
    return [...result.values()].filter((entry) => Object.values(entry.totals).some((count) => count > 0));
  }

  queryHandles(options: {
    address?: string;
    offset?: number;
    limit?: number;
    additionalAddresses?: readonly string[];
  } = {}): { handles: BlueBubblesHandle[]; total: number } {
    const addresses = new Map<string, string>();
    const add = (value: string): void => {
      const stripped = stripTransport(value);
      if (stripped) addresses.set(stripped.toLowerCase(), stripped);
    };
    for (const address of options.additionalAddresses ?? []) add(address);
    const senders = this.database.prepare("SELECT DISTINCT sender FROM message WHERE sender IS NOT NULL").all() as unknown as Array<{
      sender: string;
    }>;
    for (const row of senders) add(row.sender);
    const chats = this.database.prepare("SELECT participants_json FROM chat").all() as unknown as Array<{
      participants_json: string;
    }>;
    for (const row of chats) for (const address of safeJsonArray(row.participants_json)) add(address);

    const needle = options.address ? stripTransport(options.address).toLowerCase() : undefined;
    const all = [...addresses.entries()]
      .filter(([canonical]) => !needle || canonical === needle)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, address]) => this.serializeHandle(address));
    const offset = Math.max(options.offset ?? 0, 0);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    return { handles: all.slice(offset, offset + limit), total: all.length };
  }

  getHandle(address: string, additionalAddresses: readonly string[] = []): BlueBubblesHandle | undefined {
    return this.queryHandles({ address, additionalAddresses, limit: 1 }).handles[0];
  }

  replaceProfileVcfContacts(contacts: readonly ContactInput[]): number {
    return this.replaceContacts("profile-vcf", contacts);
  }

  replaceContacts(source: IBlueContactSource, contacts: readonly ContactInput[]): number {
    const now = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM contact WHERE source = ?").run(source);
      const insert = this.database.prepare(`
        INSERT INTO contact (
          address_key, address, source, display_name, first_name, last_name,
          nickname, avatar, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(address_key, source) DO UPDATE SET
          address=excluded.address,
          display_name=excluded.display_name,
          first_name=excluded.first_name,
          last_name=excluded.last_name,
          nickname=excluded.nickname,
          avatar=excluded.avatar,
          updated_at=excluded.updated_at
      `);
      let count = 0;
      for (const contact of contacts) {
        for (const address of contact.addresses) {
          const key = contactAddressKey(address);
          if (!key) continue;
          insert.run(
            key,
            stripTransport(address),
            source,
            contact.displayName,
            contact.firstName ?? null,
            contact.lastName ?? null,
            contact.nickname ?? null,
            contact.avatar ?? null,
            now,
          );
          count += 1;
        }
      }
      this.database.exec("COMMIT");
      return count;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  upsertNameAndPhotoContact(
    address: string,
    profile: IncomingSharedProfile,
  ): IBlueContact | undefined {
    const key = contactAddressKey(address);
    if (!key) return undefined;
    const existing = this.database.prepare(`
      SELECT * FROM contact WHERE address_key = ? AND source = 'name-and-photo-sharing'
    `).get(key) as unknown as ContactRow | undefined;
    const displayName = profile.displayName?.trim()
      || [profile.firstName?.trim(), profile.lastName?.trim()].filter(Boolean).join(" ")
      || existing?.display_name;
    if (!displayName) return this.getContact(address);
    const avatar = profile.avatarBase64 ? safeBase64(profile.avatarBase64) : undefined;
    this.database.prepare(`
      INSERT INTO contact (
        address_key, address, source, display_name, first_name, last_name,
        nickname, avatar, updated_at
      ) VALUES (?, ?, 'name-and-photo-sharing', ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(address_key, source) DO UPDATE SET
        address=excluded.address,
        display_name=excluded.display_name,
        first_name=COALESCE(excluded.first_name, contact.first_name),
        last_name=COALESCE(excluded.last_name, contact.last_name),
        avatar=COALESCE(excluded.avatar, contact.avatar),
        updated_at=excluded.updated_at
    `).run(
      key,
      stripTransport(address),
      displayName,
      profile.firstName?.trim() || null,
      profile.lastName?.trim() || null,
      avatar ?? null,
      Date.now(),
    );
    return this.getContact(address);
  }

  getContact(address: string): IBlueContact | undefined {
    const key = contactAddressKey(address);
    if (!key) return undefined;
    const row = this.#contactByAddress.get(key) as unknown as ContactRow | undefined;
    return row ? this.serializeContact(row) : undefined;
  }

  getContactAvatar(address: string): { data: Buffer; contact: IBlueContact } | undefined {
    const key = contactAddressKey(address);
    if (!key) return undefined;
    const row = this.database.prepare(`
      SELECT * FROM contact WHERE address_key = ? AND avatar IS NOT NULL
      ORDER BY CASE source WHEN 'profile-vcf' THEN 0 WHEN 'icloud-carddav' THEN 1 ELSE 2 END,
        updated_at DESC
      LIMIT 1
    `).get(key) as unknown as ContactRow | undefined;
    if (!row?.avatar?.byteLength) return undefined;
    const contact = this.getContact(address);
    if (!contact) return undefined;
    return { data: Buffer.from(row.avatar), contact };
  }

  queryContacts(options: {
    addresses?: readonly string[];
    search?: string;
    sources?: readonly IBlueContactSource[];
    offset?: number;
    limit?: number;
  } = {}): { contacts: IBlueContact[]; total: number } {
    const allowedAddresses = options.addresses?.length
      ? new Set(options.addresses.map(contactAddressKey).filter(Boolean))
      : undefined;
    const allowedSources = options.sources?.length ? new Set(options.sources) : undefined;
    const search = options.search?.trim().toLowerCase();
    const rows = this.database.prepare(`
      SELECT * FROM contact
      ORDER BY address_key,
        CASE source WHEN 'profile-vcf' THEN 0 WHEN 'icloud-carddav' THEN 1 ELSE 2 END,
        updated_at DESC
    `).all() as unknown as ContactRow[];
    const selected = new Map<string, IBlueContact>();
    for (const row of rows) {
      if (allowedAddresses && !allowedAddresses.has(row.address_key)) continue;
      if (allowedSources && !allowedSources.has(row.source)) continue;
      if (!selected.has(row.address_key)) {
        selected.set(row.address_key, this.serializeContact(row));
      }
    }
    const all = [...selected.values()]
      .filter((contact) => !search || [
        contact.address,
        contact.displayName,
        contact.firstName,
        contact.lastName,
        contact.nickname,
      ].some((value) => value?.toLowerCase().includes(search)))
      .sort((left, right) =>
        left.displayName.localeCompare(right.displayName) || left.address.localeCompare(right.address));
    const offset = Math.max(options.offset ?? 0, 0);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    return { contacts: all.slice(offset, offset + limit), total: all.length };
  }

  getSharedLocation(messageGuid: string): IBlueSharedLocationRecord | undefined {
    const row = this.#locationByMessage.get(messageGuid) as unknown as SharedLocationRow | undefined;
    return row ? this.serializeSharedLocation(row) : undefined;
  }

  setConversationBackground(
    chatGuid: string,
    background: Omit<IBlueConversationBackground, "updatedAt">,
    updatedAt = Date.now(),
  ): IBlueConversationBackground {
    this.database.prepare(`
      INSERT INTO conversation_background (
        chat_guid, removed, preset, colors_json, object_id, url, file_size, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_guid) DO UPDATE SET
        removed=excluded.removed,
        preset=excluded.preset,
        colors_json=excluded.colors_json,
        object_id=excluded.object_id,
        url=excluded.url,
        file_size=excluded.file_size,
        updated_at=excluded.updated_at
    `).run(
      chatGuid,
      background.removed ? 1 : 0,
      background.preset ?? null,
      background.colors ? JSON.stringify(background.colors) : null,
      background.objectId ?? null,
      background.url ?? null,
      background.fileSize ?? null,
      updatedAt,
    );
    return { ...background, updatedAt };
  }

  getConversationBackground(chatGuid: string): IBlueConversationBackground | undefined {
    const row = this.database.prepare(`
      SELECT * FROM conversation_background WHERE chat_guid = ?
    `).get(chatGuid) as unknown as ConversationBackgroundRow | undefined;
    if (!row) return undefined;
    return {
      removed: Boolean(row.removed),
      ...(row.preset ? { preset: row.preset } : {}),
      ...(row.colors_json ? { colors: JSON.parse(row.colors_json) as string[] } : {}),
      ...(row.object_id ? { objectId: row.object_id } : {}),
      ...(row.url ? { url: row.url } : {}),
      ...(row.file_size === null ? {} : { fileSize: row.file_size }),
      updatedAt: row.updated_at,
    };
  }

  setFocusStatus(status: IBlueFocusStatus): IBlueFocusStatus {
    this.database.prepare(`
      INSERT INTO focus_status (address_key, handle, available, mode, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(address_key) DO UPDATE SET
        handle=excluded.handle,
        available=excluded.available,
        mode=excluded.mode,
        updated_at=excluded.updated_at
    `).run(
      contactAddressKey(status.handle),
      stripTransport(status.handle),
      status.available ? 1 : 0,
      status.mode ?? null,
      status.updatedAt,
    );
    return {
      ...status,
      handle: stripTransport(status.handle),
      notificationsSilenced: !status.available,
    };
  }

  getFocusStatus(handle: string): IBlueFocusStatus | undefined {
    const row = this.database.prepare(`
      SELECT * FROM focus_status WHERE address_key = ?
    `).get(contactAddressKey(handle)) as unknown as FocusStatusRow | undefined;
    if (!row) return undefined;
    return {
      handle: row.handle,
      available: Boolean(row.available),
      notificationsSilenced: !Boolean(row.available),
      ...(row.mode ? { mode: row.mode } : {}),
      updatedAt: row.updated_at,
    };
  }

  querySharedLocations(options: {
    chatGuid?: string;
    after?: number;
    before?: number;
    offset?: number;
    limit?: number;
  } = {}): { locations: IBlueSharedLocationRecord[]; total: number } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.chatGuid) {
      clauses.push("message.chat_guid = ?");
      params.push(options.chatGuid);
    }
    if (options.after !== undefined) {
      clauses.push("message.date_created > ?");
      params.push(options.after);
    }
    if (options.before !== undefined) {
      clauses.push("message.date_created < ?");
      params.push(options.before);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const count = this.database.prepare(`
      SELECT COUNT(*) AS total FROM shared_location
      JOIN message ON message.guid = shared_location.message_guid
      ${where}
    `).get(...params) as { total: number };
    const offset = Math.max(options.offset ?? 0, 0);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const rows = this.database.prepare(`
      SELECT shared_location.*, message.chat_guid, message.sender, message.date_created
      FROM shared_location
      JOIN message ON message.guid = shared_location.message_guid
      ${where}
      ORDER BY message.date_created DESC, message.rowid DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as unknown as SharedLocationRow[];
    return {
      locations: rows.map((row) => this.serializeSharedLocation(row)),
      total: Number(count.total),
    };
  }

  updateOutgoingEdit(guid: string, text: string, timestamp = Date.now()): BlueBubblesMessage | undefined {
    this.database.prepare("UPDATE message SET text = ?, date_edited = ? WHERE guid = ?").run(text, timestamp, guid);
    return this.getMessage(guid);
  }

  updateOutgoingUnsend(guid: string, timestamp = Date.now()): BlueBubblesMessage | undefined {
    this.database.prepare("UPDATE message SET date_retracted = ? WHERE guid = ?").run(timestamp, guid);
    return this.getMessage(guid);
  }

  markMessageDelivered(guid: string, timestamp = Date.now()): BlueBubblesMessage | undefined {
    const result = this.database.prepare(`
      UPDATE message
      SET is_delivered = 1, date_delivered = COALESCE(date_delivered, ?)
      WHERE guid = ? AND is_from_me = 1
        AND (is_delivered = 0 OR date_delivered IS NULL)
    `).run(timestamp, guid);
    return Number(result.changes) > 0 ? this.getMessage(guid) : undefined;
  }

  markMessageRead(guid: string, timestamp = Date.now()): BlueBubblesMessage | undefined {
    // A peer cannot read a message it has not received, so a read receipt also
    // closes the delivered state when a distinct delivery receipt was lost.
    const result = this.database.prepare(`
      UPDATE message
      SET is_delivered = 1,
          date_delivered = COALESCE(date_delivered, ?),
          date_read = COALESCE(date_read, ?)
      WHERE guid = ? AND is_from_me = 1
        AND (is_delivered = 0 OR date_delivered IS NULL OR date_read IS NULL)
    `).run(timestamp, timestamp, guid);
    return Number(result.changes) > 0 ? this.getMessage(guid) : undefined;
  }

  markMessageError(
    guid: string,
    error: NonNullable<IncomingMessage["error"]>,
  ): BlueBubblesMessage | undefined {
    const row = this.#messageByGuid.get(guid) as unknown as MessageRow | undefined;
    if (!row || !row.is_from_me) return undefined;
    let raw: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.raw_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // Preserve the outgoing message even if an old raw_json value was
      // malformed; the structured columns remain authoritative.
    }
    const status = error.status && error.status > 0 ? error.status : 1;
    if (row.error === status && JSON.stringify(raw.error) === JSON.stringify(error)) {
      return undefined;
    }
    const result = this.database.prepare(`
      UPDATE message SET error = ?, raw_json = ?
      WHERE guid = ? AND is_from_me = 1
    `).run(status, JSON.stringify({ ...raw, error }), guid);
    return Number(result.changes) > 0 ? this.getMessage(guid) : undefined;
  }

  markChatRead(chatGuid: string, timestamp = Date.now()): void {
    this.database.prepare("UPDATE message SET date_read = ? WHERE chat_guid = ? AND is_from_me = 0 AND date_read IS NULL")
      .run(timestamp, chatGuid);
  }

  markChatUnread(chatGuid: string): void {
    this.database.prepare(`
      UPDATE message SET date_read = NULL
      WHERE guid = (
        SELECT guid FROM message
        WHERE chat_guid = ? AND is_from_me = 0
        ORDER BY date_created DESC, rowid DESC LIMIT 1
      )
    `).run(chatGuid);
  }

  lastIncomingMessageGuid(chatGuid: string): string | undefined {
    const row = this.database.prepare(`
      SELECT guid FROM message
      WHERE chat_guid = ? AND is_from_me = 0
      ORDER BY date_created DESC, rowid DESC LIMIT 1
    `).get(chatGuid) as { guid: string } | undefined;
    return row?.guid;
  }

  markMessageNotified(guid: string): BlueBubblesMessage | undefined {
    const row = this.#messageByGuid.get(guid) as unknown as MessageRow | undefined;
    if (!row) return undefined;
    const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
    raw.didNotifyRecipient = true;
    this.database.prepare("UPDATE message SET raw_json = ? WHERE guid = ?").run(JSON.stringify(raw), guid);
    return this.getMessage(guid);
  }

  getChat(guid: string, includeParticipants = true, includeLastMessage = false): BlueBubblesChat | undefined {
    const row = this.#chatByGuid.get(guid) as unknown as ChatRow | undefined;
    if (!row) return undefined;
    const chat = this.serializeChat(row, includeParticipants);
    if (includeLastMessage) {
      const last = this.database
        .prepare("SELECT * FROM message WHERE chat_guid = ? ORDER BY date_created DESC, rowid DESC LIMIT 1")
        .get(guid) as unknown as MessageRow | undefined;
      if (last) chat.lastMessage = this.serializeMessage(last, false);
    }
    return chat;
  }

  queryChats(options: { offset?: number; limit?: number; withLastMessage?: boolean } = {}): {
    chats: BlueBubblesChat[];
    total: number;
  } {
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 1000);
    const offset = Math.max(options.offset ?? 0, 0);
    const count = this.database.prepare("SELECT COUNT(*) AS total FROM chat").get() as { total: number };
    const rows = this.database
      .prepare("SELECT * FROM chat ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as unknown as ChatRow[];
    return {
      chats: rows.map((row) => this.getChat(row.guid, true, options.withLastMessage)!),
      total: Number(count.total),
    };
  }

  getAttachment(guid: string): { response: BlueBubblesAttachment; path: string | null } | undefined {
    const row = this.database.prepare("SELECT * FROM attachment WHERE guid = ?").get(guid) as
      | (AttachmentRow & { file_path: string | null })
      | undefined;
    return row
      ? {
        response: this.serializeAttachment(row, this.richLinkArtworkMimeType(row)),
        path: row.file_path,
      }
      : undefined;
  }

  async deleteMessage(chatGuid: string, messageGuid: string): Promise<boolean> {
    const row = this.database
      .prepare("SELECT chat_guid FROM message WHERE guid = ?")
      .get(messageGuid) as { chat_guid: string } | undefined;
    if (!row || row.chat_guid !== chatGuid) return false;

    const paths = this.database
      .prepare("SELECT file_path FROM attachment WHERE message_guid = ? AND file_path IS NOT NULL")
      .all(messageGuid) as unknown as Array<{ file_path: string }>;
    const deleted = Number(
      this.database.prepare("DELETE FROM message WHERE guid = ? AND chat_guid = ?").run(messageGuid, chatGuid).changes,
    ) > 0;
    if (deleted) await this.removeProfileFiles(paths.map((entry) => entry.file_path));
    return deleted;
  }

  async deleteChat(chatGuid: string): Promise<boolean> {
    const chat = this.#chatByGuid.get(chatGuid) as unknown as ChatRow | undefined;
    if (!chat) return false;
    const paths = this.database.prepare(`
      SELECT attachment.file_path
      FROM attachment
      JOIN message ON message.guid = attachment.message_guid
      WHERE message.chat_guid = ? AND attachment.file_path IS NOT NULL
    `).all(chatGuid) as unknown as Array<{ file_path: string }>;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM message WHERE chat_guid = ?").run(chatGuid);
      this.database.prepare("DELETE FROM chat WHERE guid = ?").run(chatGuid);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    await this.removeProfileFiles([
      ...paths.map((entry) => entry.file_path),
      ...(chat.icon_path ? [chat.icon_path] : []),
    ]);
    return true;
  }

  listWebhooks(filters: { id?: number; url?: string } = {}): BlueBubblesWebhook[] {
    const rows = this.database.prepare("SELECT * FROM webhook ORDER BY id ASC").all() as unknown as WebhookRow[];
    return rows
      .filter((row) => filters.id === undefined || row.id === filters.id)
      .filter((row) => filters.url === undefined || row.url === filters.url)
      .map((row) => ({
        id: row.id,
        url: row.url,
        events: safeJsonArray(row.events_json),
        created: row.created_at,
        updated: row.updated_at,
      }));
  }

  createWebhook(url: string, events: string[]): BlueBubblesWebhook {
    const now = Date.now();
    this.database
      .prepare(`
        INSERT INTO webhook (url, events_json, created_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET events_json=excluded.events_json, updated_at=excluded.updated_at
      `)
      .run(url, JSON.stringify(events), now, now);
    const webhook = this.listWebhooks({ url })[0];
    if (!webhook) throw new Error("failed to persist webhook");
    return webhook;
  }

  deleteWebhook(id: number): boolean {
    return Number(this.database.prepare("DELETE FROM webhook WHERE id = ?").run(id).changes) > 0;
  }

  enqueueWebhookDeliveries(webhookIds: readonly number[], event: unknown): number {
    if (webhookIds.length === 0) return 0;
    const payload = JSON.stringify(event);
    if (payload === undefined) throw new Error("webhook event is not JSON serializable");
    const eventType = event && typeof event === "object" && "type" in event
      ? String((event as { type: unknown }).type)
      : "unknown";
    const now = Date.now();
    const insert = this.database.prepare(`
      INSERT INTO webhook_delivery (
        webhook_id, event_type, payload_json, attempt_count,
        next_attempt_at, last_error, failed_at, created_at
      ) VALUES (?, ?, ?, 0, ?, NULL, NULL, ?)
    `);
    let inserted = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const webhookId of webhookIds) {
        insert.run(webhookId, eventType, payload, now, now);
        inserted += 1;
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return inserted;
  }

  dueWebhookDeliveries(now = Date.now(), limit = 8): PendingWebhookDelivery[] {
    const rows = this.database.prepare(`
      SELECT delivery.*, webhook.url
      FROM webhook_delivery AS delivery
      JOIN webhook ON webhook.id = delivery.webhook_id
      WHERE delivery.failed_at IS NULL
        AND delivery.next_attempt_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM webhook_delivery AS earlier
          WHERE earlier.webhook_id = delivery.webhook_id
            AND earlier.failed_at IS NULL
            AND earlier.id < delivery.id
        )
      ORDER BY delivery.id ASC
      LIMIT ?
    `).all(now, Math.max(1, limit)) as unknown as WebhookDeliveryRow[];
    return rows.map((row) => ({
      id: row.id,
      webhookId: row.webhook_id,
      url: row.url,
      eventType: row.event_type,
      payload: JSON.parse(row.payload_json) as unknown,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      ...(row.last_error ? { lastError: row.last_error } : {}),
      createdAt: row.created_at,
    }));
  }

  nextWebhookDeliveryAt(): number | undefined {
    const row = this.database.prepare(`
      SELECT MIN(delivery.next_attempt_at) AS next_attempt_at
      FROM webhook_delivery AS delivery
      WHERE delivery.failed_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM webhook_delivery AS earlier
          WHERE earlier.webhook_id = delivery.webhook_id
            AND earlier.failed_at IS NULL
            AND earlier.id < delivery.id
        )
    `).get() as { next_attempt_at: number | null };
    return row.next_attempt_at ?? undefined;
  }

  completeWebhookDelivery(id: number): void {
    this.database.prepare("DELETE FROM webhook_delivery WHERE id = ?").run(id);
  }

  recordWebhookDeliveryFailure(input: {
    id: number;
    error: string;
    nextAttemptAt: number;
    terminal: boolean;
  }): void {
    const now = Date.now();
    this.database.prepare(`
      UPDATE webhook_delivery
      SET attempt_count = attempt_count + 1,
          next_attempt_at = ?,
          last_error = ?,
          failed_at = ?
      WHERE id = ?
    `).run(
      input.nextAttemptAt,
      input.error.slice(0, 2_000),
      input.terminal ? now : null,
      input.id,
    );
  }

  webhookDeliveryCount(options: { includeFailed?: boolean } = {}): number {
    const row = this.database.prepare(
      `SELECT COUNT(*) AS total FROM webhook_delivery${options.includeFailed ? "" : " WHERE failed_at IS NULL"}`,
    ).get() as { total: number };
    return Number(row.total);
  }

  listScheduledMessages(): BlueBubblesScheduledMessage[] {
    const rows = this.database
      .prepare("SELECT * FROM scheduled_message ORDER BY id ASC")
      .all() as unknown as ScheduledMessageRow[];
    return rows.map((row) => this.serializeScheduledMessage(row));
  }

  getScheduledMessage(id: number): BlueBubblesScheduledMessage | undefined {
    const row = this.database
      .prepare("SELECT * FROM scheduled_message WHERE id = ?")
      .get(id) as unknown as ScheduledMessageRow | undefined;
    return row ? this.serializeScheduledMessage(row) : undefined;
  }

  createScheduledMessage(input: {
    payload: BlueBubblesScheduledMessagePayload;
    scheduledFor: string;
    schedule: BlueBubblesScheduledMessageSchedule;
  }): BlueBubblesScheduledMessage {
    const result = this.database.prepare(`
      INSERT INTO scheduled_message (
        type, payload_json, scheduled_for, schedule_json, status, created_at
      ) VALUES ('send-message', ?, ?, ?, 'pending', ?)
    `).run(
      JSON.stringify(input.payload),
      Date.parse(input.scheduledFor),
      JSON.stringify(input.schedule),
      Date.now(),
    );
    const message = this.getScheduledMessage(Number(result.lastInsertRowid));
    if (!message) throw new Error("failed to persist scheduled message");
    return message;
  }

  updateScheduledMessage(
    id: number,
    input: {
      payload: BlueBubblesScheduledMessagePayload;
      scheduledFor: string;
      schedule: BlueBubblesScheduledMessageSchedule;
    },
  ): BlueBubblesScheduledMessage | undefined {
    const result = this.database.prepare(`
      UPDATE scheduled_message
      SET payload_json = ?, scheduled_for = ?, schedule_json = ?,
          status = 'pending', error = NULL, sent_at = NULL
      WHERE id = ?
    `).run(
      JSON.stringify(input.payload),
      Date.parse(input.scheduledFor),
      JSON.stringify(input.schedule),
      id,
    );
    return Number(result.changes) > 0 ? this.getScheduledMessage(id) : undefined;
  }

  saveScheduledMessage(message: BlueBubblesScheduledMessage): BlueBubblesScheduledMessage | undefined {
    const result = this.database.prepare(`
      UPDATE scheduled_message
      SET payload_json = ?, scheduled_for = ?, schedule_json = ?, status = ?, error = ?, sent_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(message.payload),
      Date.parse(message.scheduledFor),
      JSON.stringify(message.schedule),
      message.status,
      message.error,
      message.sentAt === null ? null : Date.parse(message.sentAt),
      message.id,
    );
    return Number(result.changes) > 0 ? this.getScheduledMessage(message.id) : undefined;
  }

  deleteScheduledMessage(id: number): BlueBubblesScheduledMessage | undefined {
    const message = this.getScheduledMessage(id);
    if (!message) return undefined;
    this.database.prepare("DELETE FROM scheduled_message WHERE id = ?").run(id);
    return message;
  }

  private async removeProfileFiles(paths: readonly string[]): Promise<void> {
    const root = resolve(this.attachmentRoot);
    const prefix = `${root}${sep}`;
    await Promise.all(paths.map(async (candidate) => {
      const path = resolve(candidate);
      // All attachment paths are created beneath attachmentRoot. Refuse to
      // turn a corrupt or hand-edited SQLite row into an arbitrary file delete.
      if (!path.startsWith(prefix)) return;
      await rm(path, { force: true });
    }));
  }

  private serializeMessage(row: MessageRow, includeChat = true): BlueBubblesMessage {
    const raw = JSON.parse(row.raw_json) as Partial<IncomingMessage> & {
      tempGuid?: string;
      partCount?: number;
      didNotifyRecipient?: boolean;
      pollParticipantHandle?: string;
      richLink?: IBlueRichLink;
      stickerSource?: Exclude<IBlueReaction["stickerSource"], "unknown">;
    };
    const attachments = this.#attachmentsByMessage
      .all(row.guid) as unknown as AttachmentRow[];
    const handle = row.sender ? this.serializeHandle(row.sender) : null;
    const senderContact = handle?.iBlue?.contact;
    const sharedLocation = this.getSharedLocation(row.guid);
    const icloudShare = iCloudShareFromBalloon(raw.appBalloon);
    const messageFlair = messageFlairFromEffectId(raw.effect);
    const attributedText = raw.html ? parseAttributedText(raw.html) : undefined;
    const audioTranscription = raw.attachments
      ?.map((attachment) => attachment.audioTranscription?.trim())
      .find((value): value is string => Boolean(value));
    const poll = pollFromBalloon(raw.appBalloon) ? this.pollForRow(row) : undefined;
    const parsedPollVote = pollVoteUpdateFromBalloon(raw.appBalloon);
    const decodedRichLink = decodeRichLink(raw.attachments);
    const richLinkArtworkRow = decodedRichLink?.artworkAttachmentIndex === undefined
      ? undefined
      : attachments[decodedRichLink.artworkAttachmentIndex];
    const decodedRichLinkValue = decodedRichLink
      ? {
        ...decodedRichLink.value,
        ...(richLinkArtworkRow
          ? {
            artwork: {
              attachmentGuid: richLinkArtworkRow.guid,
              mimeType: decodedRichLink.artworkMimeType ?? richLinkArtworkRow.mime_type,
            },
          }
          : {}),
      } satisfies IBlueRichLink
      : undefined;
    const richLink = raw.richLink ?? decodedRichLinkValue;
    const visibleAttachments = attachments.flatMap((attachment, index) => {
      if (attachment.mime_type === RICH_LINK_METADATA_MIME) return [];
      const artworkMimeType = index === decodedRichLink?.artworkAttachmentIndex
        ? decodedRichLink.artworkMimeType
        : undefined;
      return [this.serializeAttachment(attachment, artworkMimeType)];
    });
    const reaction = iBlueReaction(
      raw.tapback,
      visibleAttachments.filter((attachment) => attachment.isSticker).map((attachment) => attachment.guid),
      raw.stickerSource,
    );
    const pollParticipantHandle = typeof raw.pollParticipantHandle === "string"
      ? stripTransport(raw.pollParticipantHandle)
      : row.sender
        ? stripTransport(row.sender)
        : undefined;
    const pollVote = parsedPollVote
      ? {
        ...parsedPollVote,
        ...(pollParticipantHandle ? { participantHandle: pollParticipantHandle } : {}),
      }
      : undefined;
    const output: BlueBubblesMessage = {
      originalROWID: row.rowid,
      guid: row.guid,
      text: row.text,
      attributedBody: attributedText ? attributedBodyFromText(attributedText) : null,
      messageSummaryInfo: null,
      handle,
      handleId: handle?.originalROWID ?? 0,
      otherHandle: raw.participantChange?.changedAddress
        ? stableInt(stripTransport(raw.participantChange.changedAddress).toLowerCase())
        : 0,
      attachments: visibleAttachments,
      subject: row.subject,
      country: null,
      error: row.error,
      dateCreated: row.date_created,
      dateRead: row.date_read,
      dateDelivered: row.date_delivered,
      isDelivered: Boolean(row.is_delivered),
      isFromMe: Boolean(row.is_from_me),
      isDelayed: false,
      isAutoReply: false,
      isSystemMessage: false,
      isServiceMessage: false,
      isForward: false,
      isArchived: false,
      hasDdResults: false,
      cacheRoomnames: row.chat_guid,
      isAudioMessage: Boolean(raw.isVoice),
      datePlayed: null,
      itemType: raw.groupRename
        ? 2
        : raw.participantChange?.action === "leave"
          ? 3
          : raw.participantChange
            ? 1
            : 0,
      groupTitle: raw.groupName ?? null,
      groupActionType: raw.participantChange?.action === "remove" ? 1 : 0,
      isExpired: false,
      balloonBundleId: raw.appBalloon?.bundleId
        ?? (richLink ? "com.apple.messages.URLBalloonProvider" : null),
      associatedMessageGuid: row.associated_guid,
      associatedMessageType: row.associated_type
        ?? (raw.tapback ? reactionName(raw.tapback.type, raw.tapback.remove) : null),
      associatedMessageEmoji: raw.tapback?.type === 6 ? raw.tapback.emoji ?? null : null,
      expressiveSendStyleId: raw.effect ?? null,
      timeExpressiveSendPlayed: null,
      replyToGuid: row.reply_guid,
      isCorrupt: false,
      isSpam: false,
      threadOriginatorGuid: row.reply_guid,
      threadOriginatorPart: raw.reply?.part ?? null,
      dateRetracted: row.date_retracted,
      dateEdited: row.date_edited,
      partCount: raw.partCount ?? (1 + visibleAttachments.length),
      payloadData: null,
      hasPayloadData: false,
      wasDeliveredQuietly: false,
      didNotifyRecipient: raw.didNotifyRecipient === true,
      shareStatus: null,
      shareDirection: null,
      iBlue: {
        source: "ids",
        ...(raw.isStoredMessage ? { storedMessage: true } : {}),
        ...(raw.verificationFailed === undefined
          ? {}
          : { senderVerificationFailed: raw.verificationFailed }),
        ...(senderContact ? { senderContact } : {}),
        ...(sharedLocation ? { sharedLocation: locationSummary(sharedLocation) } : {}),
        ...(messageFlair ? { messageFlair } : {}),
        ...(attributedText ? { attributedText } : {}),
        ...(reaction ? { reaction } : {}),
        ...(audioTranscription
          ? { audioTranscription: { text: audioTranscription, source: "apple" } }
          : {}),
        ...(richLink ? { richLink } : {}),
        ...(icloudShare ? { icloudShare } : {}),
        ...(poll ? { poll } : {}),
        ...(pollVote ? { pollVote } : {}),
        ...(raw.appBalloon ? { component: { ...raw.appBalloon } } : {}),
      },
    };
    if (raw.tempGuid) output.tempGuid = raw.tempGuid;
    if (includeChat) {
      const chat = this.getChat(row.chat_guid, true, false);
      output.chats = chat ? [chat] : [];
    }
    return output;
  }


  private pollForRow(row: MessageRow): IBluePoll | undefined {
    const raw = JSON.parse(row.raw_json) as Partial<IncomingMessage>;
    const poll = pollFromBalloon(raw.appBalloon);
    if (!poll) return undefined;

    const allowedOptions = new Set(poll.options.map((option) => option.identifier));
    const currentVotes = new Map<string, IBluePollVote[]>();
    const voteRows = this.database.prepare(`
      SELECT * FROM message
      WHERE associated_guid = ?
      ORDER BY date_created ASC, rowid ASC
    `).all(row.guid) as unknown as MessageRow[];

    for (const voteRow of voteRows) {
      const voteRaw = JSON.parse(voteRow.raw_json) as Partial<IncomingMessage> & {
        pollParticipantHandle?: string;
      };
      const update = pollVoteUpdateFromBalloon(voteRaw.appBalloon);
      if (!update) continue;

      const replacements = new Map<string, IBluePollVote[]>();
      for (const vote of update.votes) {
        if (!allowedOptions.has(vote.optionIdentifier)) continue;
        const key = stripTransport(vote.participantHandle).toLowerCase();
        const existing = replacements.get(key) ?? [];
        existing.push({ ...vote, participantHandle: stripTransport(vote.participantHandle) });
        replacements.set(key, existing);
      }
      if (replacements.size === 0) {
        const participant = voteRaw.pollParticipantHandle ?? voteRow.sender;
        if (participant) replacements.set(stripTransport(participant).toLowerCase(), []);
      }
      for (const [participant, votes] of replacements) currentVotes.set(participant, votes);
    }

    const optionOrder = new Map(poll.options.map((option, index) => [option.identifier, index]));
    const votes = [...currentVotes.values()].flat().sort((left, right) =>
      (optionOrder.get(left.optionIdentifier) ?? Number.MAX_SAFE_INTEGER)
        - (optionOrder.get(right.optionIdentifier) ?? Number.MAX_SAFE_INTEGER)
      || left.participantHandle.localeCompare(right.participantHandle));
    return { ...poll, votes };
  }

  private serializeScheduledMessage(row: ScheduledMessageRow): BlueBubblesScheduledMessage {
    return {
      id: row.id,
      type: "send-message",
      payload: JSON.parse(row.payload_json) as BlueBubblesScheduledMessagePayload,
      scheduledFor: new Date(row.scheduled_for).toISOString(),
      schedule: JSON.parse(row.schedule_json) as BlueBubblesScheduledMessageSchedule,
      status: row.status,
      error: row.error,
      sentAt: row.sent_at === null ? null : new Date(row.sent_at).toISOString(),
      created: new Date(row.created_at).toISOString(),
    };
  }

  private serializeChat(row: ChatRow, includeParticipants: boolean): BlueBubblesChat {
    const background = this.getConversationBackground(row.guid);
    return {
      originalROWID: row.rowid,
      guid: row.guid,
      style: row.style,
      chatIdentifier: row.identifier,
      isArchived: false,
      isFiltered: false,
      displayName: row.display_name ?? "",
      properties: row.icon_path
        ? [{ groupPhotoGuid: `iblue-group-icon-${stableInt(row.guid)}`, groupVersion: row.group_version }]
        : row.group_version > 0
          ? [{ groupVersion: row.group_version }]
          : null,
      ...(row.group_id ? { groupId: row.group_id } : {}),
      lastAddressedHandle: null,
      ...(background ? { iBlue: { background } } : {}),
      ...(includeParticipants
        ? { participants: safeJsonArray(row.participants_json).map((address) => this.serializeHandle(address)) }
        : {}),
    };
  }

  private serializeHandle(address: string): BlueBubblesHandle {
    const stripped = stripTransport(address);
    const contact = this.getContact(stripped);
    return {
      originalROWID: stableInt(stripped.toLowerCase()),
      address: stripped,
      service: "iMessage",
      country: "US",
      uncanonicalizedId: stripped,
      ...(contact ? { iBlue: { contact: contactSummary(contact) } } : {}),
    };
  }

  private serializeContact(row: ContactRow): IBlueContact {
    return {
      address: row.address,
      service: "iMessage",
      displayName: row.display_name,
      ...(row.first_name ? { firstName: row.first_name } : {}),
      ...(row.last_name ? { lastName: row.last_name } : {}),
      ...(row.nickname ? { nickname: row.nickname } : {}),
      source: row.source,
      hasAvatar: Boolean(row.avatar?.byteLength) || this.contactHasAvatar(row.address_key),
      updatedAt: row.updated_at,
    };
  }

  private contactHasAvatar(addressKey: string): boolean {
    const row = this.database.prepare(`
      SELECT 1 AS found FROM contact
      WHERE address_key = ? AND avatar IS NOT NULL AND length(avatar) > 0
      LIMIT 1
    `).get(addressKey) as { found: number } | undefined;
    return Boolean(row?.found);
  }

  private persistSharedLocation(message: IncomingMessage): void {
    const location = sharedLocationFromBalloon(message.appBalloon)
      ?? sharedLocationFromMessageText(message.text);
    if (!location) return;
    this.upsertSharedLocation(message.uuid, location);
  }

  private backfillStaticLocationMessages(): void {
    const rows = this.database.prepare(`
      SELECT message.guid, message.text
      FROM message
      LEFT JOIN shared_location ON shared_location.message_guid = message.guid
      WHERE shared_location.message_guid IS NULL
        AND message.text LIKE '%maps.apple.com/%'
    `).all() as unknown as Array<{ guid: string; text: string | null }>;
    for (const row of rows) {
      const location = sharedLocationFromMessageText(row.text ?? undefined);
      if (location) this.upsertSharedLocation(row.guid, location);
    }
  }

  private upsertSharedLocation(messageGuid: string, location: IBlueSharedLocation): void {
    this.database.prepare(`
      INSERT INTO shared_location (
        message_guid, latitude, longitude, label, address, url, is_live,
        session_id, bundle_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_guid) DO UPDATE SET
        latitude=excluded.latitude,
        longitude=excluded.longitude,
        label=excluded.label,
        address=excluded.address,
        url=excluded.url,
        is_live=excluded.is_live,
        session_id=excluded.session_id,
        bundle_id=excluded.bundle_id
    `).run(
      messageGuid,
      location.latitude ?? null,
      location.longitude ?? null,
      location.label ?? null,
      location.address ?? null,
      location.url,
      location.isLive ? 1 : 0,
      location.sessionId ?? null,
      location.bundleId ?? null,
    );
  }

  private serializeSharedLocation(row: SharedLocationRow): IBlueSharedLocationRecord {
    const decoded = sharedLocationFromBalloon({
      url: row.url,
      isLive: Boolean(row.is_live),
      ...(row.bundle_id ? { bundleId: row.bundle_id } : {}),
    });
    const latitude = row.latitude ?? decoded?.latitude;
    const longitude = row.longitude ?? decoded?.longitude;
    return {
      messageGuid: row.message_guid,
      chatGuid: row.chat_guid,
      sender: row.sender ? stripTransport(row.sender) : null,
      dateCreated: row.date_created,
      ...(latitude === undefined ? {} : { latitude }),
      ...(longitude === undefined ? {} : { longitude }),
      ...(row.label ? { label: row.label } : {}),
      ...(row.address ? { address: row.address } : {}),
      url: row.url,
      isLive: Boolean(row.is_live),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.bundle_id ? { bundleId: row.bundle_id } : {}),
      ...(decoded?.findMyId ? { findMyId: decoded.findMyId } : {}),
    };
  }

  private serializeAttachment(row: AttachmentRow, richLinkMimeType?: string): BlueBubblesAttachment {
    const isRichLinkArtwork = Boolean(richLinkMimeType);
    return {
      originalROWID: row.rowid,
      guid: row.guid,
      uti: isRichLinkArtwork ? richLinkArtworkUti(richLinkMimeType!) : row.uti,
      mimeType: richLinkMimeType ?? row.mime_type,
      transferState: row.file_path ? 5 : 1,
      totalBytes: row.total_bytes,
      isOutgoing: Boolean(row.is_outgoing),
      transferName: isRichLinkArtwork ? richLinkArtworkFilename(richLinkMimeType!) : row.transfer_name,
      isSticker: Boolean(row.is_sticker),
      hideAttachment: false,
      originalGuid: row.guid,
      hasLivePhoto: Boolean(row.has_live_photo),
      ...(isRichLinkArtwork ? { metadata: { iBlueRichLinkArtwork: true } } : {}),
    };
  }

  private richLinkArtworkMimeType(row: AttachmentRow): string | undefined {
    if (row.mime_type !== RICH_LINK_IMAGE_MIME) return undefined;
    const messageRow = this.#messageByGuid.get(row.message_guid) as unknown as MessageRow | undefined;
    if (!messageRow) return undefined;
    const raw = JSON.parse(messageRow.raw_json) as Partial<IncomingMessage>;
    const decoded = decodeRichLink(raw.attachments);
    if (decoded?.artworkAttachmentIndex === undefined) return undefined;
    const rows = this.#attachmentsByMessage.all(row.message_guid) as unknown as AttachmentRow[];
    if (rows[decoded.artworkAttachmentIndex]?.guid !== row.guid) return undefined;
    return decoded.artworkMimeType;
  }
}

function contactSummary(contact: IBlueContact): IBlueContactSummary {
  return {
    displayName: contact.displayName,
    ...(contact.firstName ? { firstName: contact.firstName } : {}),
    ...(contact.lastName ? { lastName: contact.lastName } : {}),
    ...(contact.nickname ? { nickname: contact.nickname } : {}),
    source: contact.source,
  };
}

function locationSummary(location: IBlueSharedLocationRecord): IBlueSharedLocation {
  const { messageGuid: _messageGuid, chatGuid: _chatGuid, sender: _sender, dateCreated: _dateCreated, ...summary } = location;
  return summary;
}

function safeBase64(value: string): Buffer | undefined {
  const compact = value.replace(/\s/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return undefined;
  try {
    return Buffer.from(compact, "base64");
  } catch {
    return undefined;
  }
}

function mediaCategory(mimeType: string, uti: string): "images" | "videos" | "locations" | "other" {
  if (mimeType.toLowerCase().startsWith("image/")) return "images";
  if (mimeType.toLowerCase().startsWith("video/")) return "videos";
  if (/location|placemark|maps/i.test(`${mimeType} ${uti}`)) return "locations";
  // BlueBubbles' 1.9.9 endpoint exposes images, videos, and locations only.
  // Keep other file attachments out of those totals.
  return "other";
}

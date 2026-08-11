import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { IMessageEngine } from "../native/engine.js";
import type { SessionStore } from "../profile.js";
import type {
  EngineSnapshot,
  Conversation,
  IncomingMessage,
  InitializeParams,
  PersistedSession,
  SendAttachmentParams,
  SendMultipartMessageParams,
  NativeFindMyFollow,
} from "../types.js";
import type {
  BlueBubblesChat,
  BlueBubblesMessage,
  BlueBubblesReaction,
  IBlueLiveLocation,
  IBluePoll,
} from "./contracts.js";
import { contactAddressKey } from "./contact.js";
import {
  conversationFromDirectChatGuid,
  chatIdentifier,
  deriveIncomingChatGuid,
  directChatGuid,
  groupChatGuid,
  stripTransport,
  toTransportAddress,
} from "./guid.js";
import { BlueBubblesScheduler } from "./scheduler.js";
import { BlueBubblesStore, type QueryOptions } from "./store.js";
import { encodePollDefinition, encodePollVote } from "./polls.js";
import { encodeRichLinkTransport } from "./rich-link.js";
import { encodeICloudShareTransport } from "./icloud-share.js";

export interface BlueBubblesEvent {
  type: string;
  data: unknown;
}

export interface BlueBubblesServiceOptions {
  profile: string;
  password: string;
  engine: IMessageEngine;
  store: BlueBubblesStore;
  sessionStore: SessionStore;
  /** Test/embedding overrides; BlueBubbles' HTTP contract is unchanged. */
  webhookRetryDelaysMs?: readonly number[];
  webhookTimeoutMs?: number;
  webhookMaxAttempts?: number;
}

const DEFAULT_WEBHOOK_RETRY_DELAYS_MS = [
  1_000,
  5_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
] as const;

function normalizedReply(
  replyGuid: string | undefined,
  replyPart: string | number | undefined,
): { replyGuid?: string; replyPart?: string } {
  if (!replyGuid) return {};
  return {
    replyGuid,
    // rustpush serializes replies as `r:<part>:<guid>` and requires both
    // values. BlueBubbles clients commonly omit partIndex for the first text
    // part, whose protocol index is zero.
    replyPart: replyPart === undefined || replyPart === "" ? "0" : String(replyPart),
  };
}

function outgoingControlTarget(message: IncomingMessage): string {
  return message.error?.forUuid ?? message.uuid;
}

export class BlueBubblesService extends EventEmitter {
  readonly profile: string;
  readonly password: string;
  readonly engine: IMessageEngine;
  readonly store: BlueBubblesStore;
  readonly sessionStore: SessionStore;
  readonly scheduler: BlueBubblesScheduler;

  #snapshot?: EngineSnapshot;
  #saveChain = Promise.resolve();
  #webhookStarted = false;
  #webhookStopping = false;
  #webhookTimer: ReturnType<typeof setTimeout> | undefined;
  #webhookTimerAt: number | undefined;
  #webhookDrain: Promise<void> | undefined;
  #webhookWakeRequested = false;
  #incomingTasks = new Set<Promise<void>>();
  #outgoingAnnouncements = new Set<string>();
  #pendingOutgoingControls = new Map<
    string,
    Array<{ message: IncomingMessage; receivedAt: number }>
  >();
  readonly #webhookRetryDelaysMs: readonly number[];
  readonly #webhookTimeoutMs: number;
  readonly #webhookMaxAttempts: number;

  constructor(options: BlueBubblesServiceOptions) {
    super();
    this.profile = options.profile;
    this.password = options.password;
    this.engine = options.engine;
    this.store = options.store;
    this.sessionStore = options.sessionStore;
    this.#webhookRetryDelaysMs = options.webhookRetryDelaysMs?.length
      ? options.webhookRetryDelaysMs.map((value) => Math.max(0, value))
      : DEFAULT_WEBHOOK_RETRY_DELAYS_MS;
    this.#webhookTimeoutMs = Math.max(1, options.webhookTimeoutMs ?? 15_000);
    this.#webhookMaxAttempts = Math.max(1, options.webhookMaxAttempts ?? 12);
    this.scheduler = new BlueBubblesScheduler({
      store: this.store,
      send: (payload) => this.sendText({
        chatGuid: payload.chatGuid,
        message: payload.message,
        ...(payload.selectedMessageGuid ? { selectedMessageGuid: payload.selectedMessageGuid } : {}),
        ...(payload.effectId ? { effectId: payload.effectId } : {}),
        ...(payload.subject ? { subject: payload.subject } : {}),
        ...(payload.attributedBody ? { attributedBody: payload.attributedBody } : {}),
        ...(payload.partIndex === undefined ? {} : { partIndex: payload.partIndex }),
      }),
      dispatch: (type, data) => this.dispatch(type, data),
    });

    this.engine.on("message.received", (message) => {
      const task = this.#handleIncoming(message);
      this.#incomingTasks.add(task);
      void task
        .catch((error) => this.emit("error", error))
        .finally(() => this.#incomingTasks.delete(task));
    });
    this.engine.on("account.stateChanged", (state) => this.#handleAccountStateChanged(state));
    this.engine.on("engine.log", (entry) => this.emit("log", entry));
  }

  get snapshot(): EngineSnapshot | undefined {
    return this.#snapshot;
  }

  get handles(): string[] {
    return this.#snapshot?.handles ?? [];
  }

  async start(
    session: PersistedSession,
    overrides: Pick<InitializeParams, "hardwareKey"> = {},
  ): Promise<EngineSnapshot> {
    this.#snapshot = await this.engine.initialize({
      ...(session.deviceId ? { deviceId: session.deviceId } : {}),
      ...(session.apsState ? { apsState: session.apsState } : {}),
      ...(session.users ? { users: session.users } : {}),
      ...(session.identity ? { identity: session.identity } : {}),
      ...(session.account ? { account: session.account } : {}),
      ...overrides,
    });
    // A legacy session may contain the IDS credential record. Initialization
    // migrates it into the OS credential store; rewrite the file before any later startup step
    // so the plaintext copy is removed even if client registration then fails.
    await this.sessionStore.save(this.#snapshot);
    this.#snapshot = await this.engine.startClient();
    await this.sessionStore.save(this.#snapshot);
    await this.scheduler.start();
    this.#webhookStopping = false;
    this.#webhookStarted = true;
    this.#scheduleWebhookDrain(0);
    return this.#snapshot;
  }

  scheduleSnapshot(): void {
    this.#saveChain = this.#saveChain
      .then(async () => {
        this.#snapshot = await this.engine.snapshot();
        await this.sessionStore.save(this.#snapshot);
      })
      .catch((error) => {
        this.emit("error", error);
      });
  }

  async health(): Promise<{
    profile: string;
    handles: string[];
    clientStarted: boolean;
    secondsSinceLastInbound: number;
  }> {
    const health = await this.engine.health();
    return { profile: this.profile, handles: this.handles, ...health };
  }

  queryMessages(options: QueryOptions): { messages: BlueBubblesMessage[]; total: number } {
    return this.store.queryMessages(options);
  }

  async sendText(body: {
    chatGuid: string;
    message: string;
    tempGuid?: string;
    subject?: string;
    effectId?: string;
    selectedMessageGuid?: string;
    partIndex?: number;
    attributedBody?: string;
  }): Promise<BlueBubblesMessage> {
    this.requireOutboundIds("send a message");
    const conversation = this.resolveConversation(body.chatGuid);
    const reply = normalizedReply(body.selectedMessageGuid, body.partIndex);
    const result = await this.engine.sendMessage({
      conversation,
      text: body.message,
      ...(body.attributedBody ? { html: body.attributedBody } : {}),
      ...(body.subject ? { subject: body.subject } : {}),
      ...(body.effectId ? { effectId: body.effectId } : {}),
      ...reply,
    });
    this.#beginOutgoingAnnouncement(result.guid);
    let message: BlueBubblesMessage;
    try {
      message = this.store.insertOutgoing({
        guid: result.guid,
        ...(body.tempGuid ? { tempGuid: body.tempGuid } : {}),
        chatGuid: body.chatGuid,
        text: body.message,
        ...(body.subject ? { subject: body.subject } : {}),
        ...(body.effectId ? { effect: body.effectId } : {}),
        ...reply,
      });
      this.#publishOutgoing(result.guid, "new-message", message);
    } finally {
      this.#finishOutgoingAnnouncement(result.guid);
    }
    this.scheduleSnapshot();
    return message;
  }

  async sendReaction(body: {
    chatGuid: string;
    selectedMessageGuid: string;
    reaction: BlueBubblesReaction;
    partIndex?: number;
  }): Promise<BlueBubblesMessage> {
    this.requireOutboundIds("send a reaction");
    const target = this.store.getMessage(body.selectedMessageGuid);
    if (!target) throw new Error("Selected message does not exist!");
    const remove = body.reaction.startsWith("-");
    const reaction = body.reaction.replace(/^-/, "") as Exclude<BlueBubblesReaction, `-${string}`>;
    const result = await this.engine.sendReaction({
      conversation: this.resolveConversation(body.chatGuid),
      targetUuid: body.selectedMessageGuid,
      targetPart: body.partIndex ?? 0,
      targetText: target.text ?? (target.attachments.length > 0 ? "\u{fffc}" : ""),
      reaction: reaction === "love" ? "heart" : reaction,
      remove,
    });
    this.#beginOutgoingAnnouncement(result.guid);
    let message: BlueBubblesMessage;
    try {
      message = this.store.insertOutgoing({
        guid: result.guid,
        chatGuid: body.chatGuid,
        text: nullReactionText(body.reaction),
        associatedGuid: body.selectedMessageGuid,
        associatedType: body.reaction,
      });
      this.#publishOutgoing(result.guid, "new-message", message);
    } finally {
      this.#finishOutgoingAnnouncement(result.guid);
    }
    this.scheduleSnapshot();
    return message;
  }

  async sendPollVote(body: {
    messageGuid: string;
    optionIdentifiers: readonly string[];
  }): Promise<{ message: BlueBubblesMessage; poll: IBluePoll }> {
    this.requireOutboundIds("vote in a poll");
    const target = this.store.getMessage(body.messageGuid);
    if (!target) throw new Error("Poll message does not exist!");
    const poll = this.store.getPoll(body.messageGuid);
    if (!poll) throw new Error("Selected message is not an Apple Messages poll!");
    if (!poll.sessionId) throw new Error("Poll message does not include a session ID!");
    const chatGuid = target.cacheRoomnames;
    if (!chatGuid) throw new Error("Poll message is not associated with a chat!");
    const from = this.handles[0];
    if (!from) throw new Error("The account has no registered sending handle!");

    const optionIdentifiers = [...new Set(body.optionIdentifiers)];
    const validOptions = new Set(poll.options.map((option) => option.identifier));
    const invalid = optionIdentifiers.find((identifier) => !validOptions.has(identifier));
    if (invalid) throw new Error(`Unknown poll option identifier: ${invalid}`);

    const participantHandle = stripTransport(from);
    const encoded = encodePollVote(poll.sessionId, participantHandle, optionIdentifiers);
    const result = await this.engine.sendPollVote({
      conversation: this.resolveConversation(chatGuid),
      targetUuid: body.messageGuid,
      sessionId: poll.sessionId,
      pollResponseJson: encoded.json,
      from,
    });
    this.#beginOutgoingAnnouncement(result.guid);
    let message: BlueBubblesMessage;
    try {
      message = this.store.insertOutgoing({
        guid: result.guid,
        chatGuid,
        associatedGuid: body.messageGuid,
        associatedType: "poll-vote",
        appBalloon: encoded.balloon,
        pollParticipantHandle: participantHandle,
      });
      this.#publishOutgoing(result.guid, "new-message", message);
    } finally {
      this.#finishOutgoingAnnouncement(result.guid);
    }
    this.scheduleSnapshot();
    return { message, poll: this.store.getPoll(body.messageGuid) ?? poll };
  }

  async sendPoll(body: {
    chatGuid: string;
    options: readonly string[];
    title?: string;
  }): Promise<BlueBubblesMessage> {
    this.requireOutboundIds("send a poll");
    const from = this.handles[0];
    if (!from) throw new Error("The account has no registered sending handle!");
    const encoded = encodePollDefinition(stripTransport(from), body.options, body.title ?? "");
    const result = await this.engine.sendMessage({
      conversation: this.resolveConversation(body.chatGuid),
      text: encoded.transportText,
      from,
    });
    this.#beginOutgoingAnnouncement(result.guid);
    let message: BlueBubblesMessage;
    try {
      message = this.store.insertOutgoing({
        guid: result.guid,
        chatGuid: body.chatGuid,
        text: "\ufffc",
        appBalloon: encoded.balloon,
      });
      this.#publishOutgoing(result.guid, "new-message", message);
    } finally {
      this.#finishOutgoingAnnouncement(result.guid);
    }
    this.scheduleSnapshot();
    return message;
  }

  async sendRichLink(body: {
    chatGuid: string;
    originalUrl: string;
    url?: string;
    title?: string;
    summary?: string;
    artwork?: { attachmentGuid: string; path: string; mimeType: string };
    appleMusicPlayback?: {
      storefrontIdentifier: string;
      storeIdentifier: string;
      name: string;
      artist: string;
      album: string;
      previewUrl: string;
    };
  }): Promise<BlueBubblesMessage> {
    this.requireOutboundIds("send a rich link");
    const artworkDataBase64 = body.artwork
      ? (await readFile(body.artwork.path)).toString("base64")
      : undefined;
    const encoded = encodeRichLinkTransport({
      originalUrl: body.originalUrl,
      ...(body.url ? { url: body.url } : {}),
      ...(body.title ? { title: body.title } : {}),
      ...(body.summary ? { summary: body.summary } : {}),
      ...(body.artwork
        ? {
          artworkMimeType: body.artwork.mimeType,
          artworkDataBase64: artworkDataBase64!,
          artworkAttachmentGuid: body.artwork.attachmentGuid,
        }
        : {}),
      ...(body.appleMusicPlayback ? { appleMusicPlayback: body.appleMusicPlayback } : {}),
    });
    const result = await this.engine.sendMessage({
      conversation: this.resolveConversation(body.chatGuid),
      text: encoded.transportText,
    });
    this.#beginOutgoingAnnouncement(result.guid);
    let message: BlueBubblesMessage;
    try {
      message = this.store.insertOutgoing({
        guid: result.guid,
        chatGuid: body.chatGuid,
        text: body.url ?? body.originalUrl,
        appBalloon: {
          bundleId: "com.apple.messages.URLBalloonProvider",
          isLive: false,
        },
        richLink: encoded.richLink,
      });
      this.#publishOutgoing(result.guid, "new-message", message);
    } finally {
      this.#finishOutgoingAnnouncement(result.guid);
    }
    this.scheduleSnapshot();
    return message;
  }

  async sendICloudShare(body: {
    chatGuid: string;
    url: string;
    caption?: string;
    subcaption?: string;
    ldText?: string;
  }): Promise<BlueBubblesMessage> {
    this.requireOutboundIds("send an iCloud Photos share");
    const encoded = encodeICloudShareTransport(body);
    const result = await this.engine.sendMessage({
      conversation: this.resolveConversation(body.chatGuid),
      text: encoded.transportText,
    });
    this.#beginOutgoingAnnouncement(result.guid);
    let message: BlueBubblesMessage;
    try {
      message = this.store.insertOutgoing({
        guid: result.guid,
        chatGuid: body.chatGuid,
        text: "\ufffd\ufffc",
        appBalloon: encoded.balloon,
      });
      this.#publishOutgoing(result.guid, "new-message", message);
    } finally {
      this.#finishOutgoingAnnouncement(result.guid);
    }
    this.scheduleSnapshot();
    return message;
  }

  async createICloudPhotoShare(body: {
    chatGuid: string;
    path: string;
    filename: string;
    mimeType: string;
    title?: string;
  }): Promise<import("../native/engine.js").FreshICloudPhotoShare> {
    this.requireOutboundIds("create an iCloud Photos share");
    // Resolve the conversation before uploading anything so an invalid chat
    // cannot leave a fresh Photos asset and CMM zone behind.
    this.resolveConversation(body.chatGuid);
    if (!this.engine.createICloudPhotoShare) {
      throw new Error("The native engine does not support fresh iCloud Photos shares");
    }
    return this.engine.createICloudPhotoShare({
      path: body.path,
      filename: body.filename,
      mimeType: body.mimeType,
      ...(body.title === undefined ? {} : { title: body.title }),
    });
  }

  async sendAttachment(
    body: Omit<SendAttachmentParams, "conversation"> & { chatGuid: string; tempGuid?: string },
  ): Promise<BlueBubblesMessage> {
    this.requireOutboundIds("send an attachment");
    const reply = normalizedReply(body.replyGuid, body.replyPart);
    const result = await this.engine.sendAttachment({
      conversation: this.resolveConversation(body.chatGuid),
      path: body.path,
      mimeType: body.mimeType,
      utiType: body.utiType,
      ...(body.filename ? { filename: body.filename } : {}),
      ...(body.from ? { from: body.from } : {}),
      ...reply,
      ...(body.caption ? { caption: body.caption } : {}),
      ...(body.effectId ? { effectId: body.effectId } : {}),
      ...(body.isAudioMessage ? { isAudioMessage: true } : {}),
    });
    this.#beginOutgoingAnnouncement(result.guid);
    let message: BlueBubblesMessage;
    try {
      this.store.insertOutgoing({
        guid: result.guid,
        ...(body.tempGuid ? { tempGuid: body.tempGuid } : {}),
        chatGuid: body.chatGuid,
        ...(body.caption ? { subject: body.caption } : {}),
        ...(body.effectId ? { effect: body.effectId } : {}),
        ...(body.isAudioMessage ? { isVoice: true } : {}),
        ...reply,
      });
      message = await this.store.persistOutgoingAttachment({
        messageGuid: result.guid,
        sourcePath: body.path,
        filename: body.filename ?? body.path.split("/").at(-1) ?? "attachment",
        mimeType: body.mimeType,
        utiType: body.utiType,
      });
      this.#publishOutgoing(result.guid, "new-message", message);
    } finally {
      this.#finishOutgoingAnnouncement(result.guid);
    }
    this.scheduleSnapshot();
    return message;
  }

  async sendMultipart(
    body: Omit<SendMultipartMessageParams, "conversation"> & {
      chatGuid: string;
      tempGuid?: string;
    },
  ): Promise<BlueBubblesMessage> {
    this.requireOutboundIds("send a multipart message");
    const reply = normalizedReply(body.replyGuid, body.replyPart);
    const result = await this.engine.sendMultipartMessage({
      conversation: this.resolveConversation(body.chatGuid),
      parts: body.parts,
      ...(body.from ? { from: body.from } : {}),
      ...(body.subject ? { subject: body.subject } : {}),
      ...(body.effectId ? { effectId: body.effectId } : {}),
      ...reply,
      ...(body.ddScan === undefined ? {} : { ddScan: body.ddScan }),
    });
    this.#beginOutgoingAnnouncement(result.guid);
    let message: BlueBubblesMessage;
    try {
      const text = body.parts.flatMap((part) => part.path ? [] : [part.text ?? ""]).join("");
      this.store.insertOutgoing({
        guid: result.guid,
        ...(body.tempGuid ? { tempGuid: body.tempGuid } : {}),
        chatGuid: body.chatGuid,
        ...(text ? { text } : {}),
        ...(body.subject ? { subject: body.subject } : {}),
        ...reply,
        ...(body.effectId ? { effect: body.effectId } : {}),
        partCount: new Set(body.parts.map((part) => part.partIndex)).size,
      });
      const attachments = body.parts.flatMap((part) => {
        if (!part.path || !part.filename || !part.mimeType || !part.utiType) return [];
        return [{
          sourcePath: part.path,
          filename: part.filename,
          mimeType: part.mimeType,
          utiType: part.utiType,
        }];
      });
      const persisted = attachments.length > 0
        ? await this.store.persistOutgoingAttachments({ messageGuid: result.guid, attachments })
        : this.store.getMessage(result.guid);
      if (!persisted) throw new Error(`failed to reload multipart message ${result.guid}`);
      message = persisted;
      if (body.tempGuid) message.tempGuid = body.tempGuid;
      this.#publishOutgoing(result.guid, "new-message", message);
    } finally {
      this.#finishOutgoingAnnouncement(result.guid);
    }
    this.scheduleSnapshot();
    return message;
  }

  async isIMessageAvailable(address: string): Promise<boolean> {
    this.requireOutboundIds("query iMessage availability");
    const target = toTransportAddress(address);
    const result = await this.engine.validateHandles({ addresses: [target] });
    const canonical = target.toLowerCase();
    return result.available.some((value) => toTransportAddress(value).toLowerCase() === canonical);
  }

  async refreshLiveLocations(address?: string): Promise<IBlueLiveLocation[]> {
    const refresh = this.engine.refreshFindMyFollowing;
    if (!refresh) throw new Error("native engine does not support Find My live-location refresh");
    const requested = address ? contactAddressKey(address) : undefined;
    const follows = await refresh.call(this.engine, address);
    const now = Date.now();
    return follows
      .filter((follow) => !requested || [...follow.invitationAcceptedHandles, ...follow.invitationFromHandles]
        .some((handle) => contactAddressKey(handle) === requested))
      .map((follow) => liveLocationFromFollow(follow, now))
      .filter((location) => location.isActive);
  }

  async editMessage(body: {
    messageGuid: string;
    editedMessage: string;
    partIndex?: number;
  }): Promise<BlueBubblesMessage> {
    this.requireOutboundIds("edit a message");
    const target = this.store.getMessage(body.messageGuid);
    const chatGuid = target?.chats?.[0]?.guid;
    if (!target || !chatGuid) throw new Error("Selected message does not exist!");
    await this.engine.sendEdit({
      conversation: this.resolveConversation(chatGuid),
      targetUuid: body.messageGuid,
      targetPart: body.partIndex ?? 0,
      text: body.editedMessage,
    });
    const message = this.store.updateOutgoingEdit(body.messageGuid, body.editedMessage);
    if (!message) throw new Error("Selected message does not exist!");
    this.dispatch("updated-message", message);
    this.scheduleSnapshot();
    return message;
  }

  async unsendMessage(body: { messageGuid: string; partIndex?: number }): Promise<BlueBubblesMessage> {
    this.requireOutboundIds("unsend a message");
    const target = this.store.getMessage(body.messageGuid);
    const chatGuid = target?.chats?.[0]?.guid;
    if (!target || !chatGuid) throw new Error("Selected message does not exist!");
    await this.engine.sendUnsend({
      conversation: this.resolveConversation(chatGuid),
      targetUuid: body.messageGuid,
      targetPart: body.partIndex ?? 0,
    });
    const message = this.store.updateOutgoingUnsend(body.messageGuid);
    if (!message) throw new Error("Selected message does not exist!");
    this.dispatch("updated-message", message);
    this.scheduleSnapshot();
    return message;
  }

  async setTyping(chatGuid: string, active: boolean): Promise<void> {
    this.requireOutboundIds("send a typing indicator");
    await this.engine.sendTyping({ conversation: this.resolveConversation(chatGuid), active });
  }

  async markChatRead(chatGuid: string, forUuid?: string): Promise<void> {
    this.requireOutboundIds("send a read receipt");
    const receiptTarget = forUuid ?? this.store.lastIncomingMessageGuid(chatGuid);
    if (receiptTarget) {
      await this.engine.sendReadReceipt({
        conversation: this.resolveConversation(chatGuid),
        forUuid: receiptTarget,
      });
    }
    this.store.markChatRead(chatGuid);
    this.dispatch("chat-read-status-changed", { chatGuid, read: true });
  }

  async markChatUnread(chatGuid: string): Promise<void> {
    this.requireOutboundIds("mark a chat unread");
    const forUuid = this.store.lastIncomingMessageGuid(chatGuid);
    if (!forUuid) throw new Error("Chat has no incoming message to mark unread!");
    await this.engine.sendMarkUnread({ conversation: this.resolveConversation(chatGuid), forUuid });
    this.store.markChatUnread(chatGuid);
    this.dispatch("chat-read-status-changed", { chatGuid, read: false });
    this.scheduleSnapshot();
  }

  async notifyMessage(messageGuid: string): Promise<BlueBubblesMessage> {
    this.requireOutboundIds("notify a recipient");
    const message = this.store.getMessage(messageGuid);
    const chatGuid = message?.chats?.[0]?.guid;
    if (!message || !chatGuid) throw new Error("Selected message does not exist!");
    if (message.didNotifyRecipient) throw new Error("The recipient has already been notified of this message!");
    await this.engine.sendNotify({ conversation: this.resolveConversation(chatGuid), forUuid: messageGuid });
    const updated = this.store.markMessageNotified(messageGuid);
    if (!updated) throw new Error("Selected message does not exist!");
    this.dispatch("updated-message", updated);
    this.scheduleSnapshot();
    return updated;
  }

  async renameGroup(chatGuid: string, newName: string): Promise<BlueBubblesChat> {
    this.requireOutboundIds("rename a group");
    const conversation = this.requireGroupConversation(chatGuid);
    const result = await this.engine.renameGroup({ conversation, newName });
    this.#beginOutgoingAnnouncement(result.guid);
    try {
      const message = await this.ingestOutgoingGroupControl(
        chatGuid,
        conversation,
        result.guid,
        { groupRename: { name: newName } },
        newName,
      );
      this.#publishOutgoing(result.guid, "group-name-change", message);
    } finally {
      this.#finishOutgoingAnnouncement(result.guid);
    }
    this.scheduleSnapshot();
    const chat = this.store.getChat(chatGuid, true, true);
    if (!chat) throw new Error("Chat does not exist!");
    return chat;
  }

  async changeGroupParticipant(
    chatGuid: string,
    address: string,
    action: "add" | "remove",
  ): Promise<BlueBubblesChat> {
    this.requireOutboundIds(`${action} a group participant`);
    const conversation = this.requireGroupConversation(chatGuid);
    const canonical = toTransportAddress(address);
    const targetKey = stripTransport(canonical).toLowerCase();
    const current = [...conversation.participants];
    const existingIndex = current.findIndex(
      (value) => stripTransport(value).toLowerCase() === targetKey,
    );
    if (action === "add" && existingIndex >= 0) throw new Error("Participant is already in the chat!");
    if (action === "remove" && existingIndex < 0) throw new Error("Participant is not in the chat!");
    const next = action === "add"
      ? [...current, canonical]
      : current.filter((_, index) => index !== existingIndex);
    const groupVersion = this.store.reserveGroupVersion(chatGuid);
    const result = await this.engine.changeGroupParticipants({
      conversation,
      newParticipants: next,
      groupVersion,
    });
    const updatedConversation: Conversation = { ...conversation, participants: next };
    this.#beginOutgoingAnnouncement(result.guid);
    try {
      const message = await this.ingestOutgoingGroupControl(
        chatGuid,
        updatedConversation,
        result.guid,
        { participantChange: { participants: next, groupVersion } },
      );
      this.#publishOutgoing(
        result.guid,
        action === "add" ? "participant-added" : "participant-removed",
        message,
      );
    } finally {
      this.#finishOutgoingAnnouncement(result.guid);
    }
    this.scheduleSnapshot();
    const chat = this.store.getChat(chatGuid, true, true);
    if (!chat) throw new Error("Chat does not exist!");
    return chat;
  }

  async leaveGroup(chatGuid: string): Promise<BlueBubblesMessage> {
    this.requireOutboundIds("leave a group");
    const conversation = this.requireGroupConversation(chatGuid);
    const sender = this.handles[0];
    if (!sender) throw new Error("No registered iMessage handle is available!");
    const groupVersion = this.store.reserveGroupVersion(chatGuid);
    const result = await this.engine.leaveGroup({ conversation, groupVersion, from: sender });
    this.#beginOutgoingAnnouncement(result.guid);
    let message: BlueBubblesMessage;
    try {
      message = await this.ingestOutgoingGroupControl(
        chatGuid,
        conversation,
        result.guid,
        {
          participantChange: {
            participants: conversation.participants,
            groupVersion,
            action: "leave",
            changedAddress: sender,
          },
        },
      );
      this.#publishOutgoing(result.guid, "participant-left", message);
    } finally {
      this.#finishOutgoingAnnouncement(result.guid);
    }
    this.scheduleSnapshot();
    return message;
  }

  async setGroupIcon(
    chatGuid: string,
    icon?: { path: string; mimeType: string },
  ): Promise<void> {
    this.requireOutboundIds(icon ? "set a group icon" : "remove a group icon");
    const conversation = this.requireGroupConversation(chatGuid);
    const groupVersion = this.store.reserveGroupVersion(chatGuid);
    const data = icon ? await readFile(icon.path) : undefined;
    const result = await this.engine.setGroupIcon({
      conversation,
      groupVersion,
      ...(icon ? { path: icon.path } : {}),
    });
    this.#beginOutgoingAnnouncement(result.guid);
    try {
      const message = await this.ingestOutgoingGroupControl(chatGuid, conversation, result.guid, {
        groupIconChange: {
          cleared: !icon,
          ...(data ? { dataBase64: data.toString("base64"), mimeType: icon!.mimeType } : {}),
          groupVersion,
        },
      });
      this.#publishOutgoing(
        result.guid,
        icon ? "group-icon-changed" : "group-icon-removed",
        message,
      );
    } finally {
      this.#finishOutgoingAnnouncement(result.guid);
    }
    this.scheduleSnapshot();
  }

  createChat(addresses: string[], displayName?: string): string {
    const participants = addresses.map(toTransportAddress);
    const group = participants.length > 1;
    const guid = group
      ? groupChatGuid(`iblue-${randomUUID()}`)
      : directChatGuid(participants[0] ?? "unknown");
    this.store.upsertChat(guid, {
      participants,
      ...(displayName ? { groupName: displayName } : {}),
      ...(group ? { senderGuid: guid.split(";").slice(2).join(";") } : {}),
    });
    return guid;
  }

  #beginOutgoingAnnouncement(guid: string): void {
    this.#outgoingAnnouncements.add(guid.toLowerCase());
  }

  #publishOutgoing(guid: string, eventType: string, message: BlueBubblesMessage): void {
    try {
      this.dispatch(eventType, message);
    } finally {
      this.#finishOutgoingAnnouncement(guid);
    }
  }

  #finishOutgoingAnnouncement(guid: string): void {
    const key = guid.toLowerCase();
    if (!this.#outgoingAnnouncements.delete(key)) return;
    const controls = this.#pendingOutgoingControls.get(key);
    if (!controls) return;
    this.#pendingOutgoingControls.delete(key);
    for (const { message } of controls) {
      if (!this.#applyOutgoingControl(message)) this.#bufferOutgoingControl(message);
    }
  }

  #handleOutgoingControl(message: IncomingMessage): void {
    const key = outgoingControlTarget(message).toLowerCase();
    if (this.#outgoingAnnouncements.has(key) || !this.#applyOutgoingControl(message)) {
      this.#bufferOutgoingControl(message);
    }
  }

  #applyOutgoingControl(message: IncomingMessage): boolean {
    const target = outgoingControlTarget(message);
    const existing = this.store.getMessage(target);
    if (!existing) return false;
    // A receipt cannot validly change an inbound row. Consume it without
    // buffering forever if corrupt or unrelated traffic reuses that UUID.
    if (!existing.isFromMe) return true;

    const updated = message.error
      ? this.store.markMessageError(target, message.error)
      : message.readReceipt
        ? this.store.markMessageRead(target, message.timestampMs || Date.now())
        : this.store.markMessageDelivered(target, message.timestampMs || Date.now());
    if (!updated) return true;
    const serialized = message.verificationFailed === undefined
      ? updated
      : {
          ...updated,
          iBlue: { ...updated.iBlue, senderVerificationFailed: message.verificationFailed },
        };
    this.dispatch(message.error ? "message-send-error" : "updated-message", serialized);
    this.scheduleSnapshot();
    return true;
  }

  #bufferOutgoingControl(message: IncomingMessage): void {
    const now = Date.now();
    const cutoff = now - 15 * 60_000;
    for (const [key, controls] of this.#pendingOutgoingControls) {
      const live = controls.filter(({ receivedAt }) => receivedAt >= cutoff);
      if (live.length === 0) this.#pendingOutgoingControls.delete(key);
      else if (live.length !== controls.length) this.#pendingOutgoingControls.set(key, live);
    }

    const key = outgoingControlTarget(message).toLowerCase();
    if (!this.#pendingOutgoingControls.has(key) && this.#pendingOutgoingControls.size >= 256) {
      const oldest = this.#pendingOutgoingControls.keys().next().value as string | undefined;
      if (oldest) this.#pendingOutgoingControls.delete(oldest);
    }
    const controls = this.#pendingOutgoingControls.get(key) ?? [];
    controls.push({ message, receivedAt: now });
    if (controls.length > 8) controls.shift();
    this.#pendingOutgoingControls.set(key, controls);
  }

  resolveConversation(chatGuid: string) {
    const existing = this.store.conversationForChat(chatGuid);
    if (existing) return existing;
    const direct = conversationFromDirectChatGuid(chatGuid);
    if (!direct) throw new Error(`Unknown group chat: ${chatGuid}`);
    this.store.ensureDirectChat(chatGuid, direct);
    return direct;
  }

  private requireOutboundIds(operation: string): void {
    if (this.#snapshot?.idsMode !== "passive") return;
    throw new Error(
      `IDS passive receive mode blocks attempts to ${operation}; ` +
      "run one sparse ids-probe after the cooldown and disable the policy only after it returns available",
    );
  }

  private requireGroupConversation(chatGuid: string): Conversation {
    const conversation = this.store.conversationForChat(chatGuid);
    if (!conversation) throw new Error("Chat does not exist!");
    // A group remains a group even after membership drops to one remote
    // participant. The durable BB/IDS group GUID is authoritative; using the
    // current participant count would incorrectly disable later rename/icon
    // controls on a still-existing conversation.
    if (conversation.isSms || !chatGuid.startsWith("iMessage;+;")) {
      throw new Error("Chat is not a group chat!");
    }
    return conversation;
  }

  private async ingestOutgoingGroupControl(
    chatGuid: string,
    conversation: Conversation,
    guid: string,
    control: Partial<IncomingMessage>,
    groupName = conversation.groupName,
  ): Promise<BlueBubblesMessage> {
    return this.store.ingestIncoming({
      uuid: guid,
      ...(this.handles[0] ? { sender: this.handles[0] } : {}),
      participants: conversation.participants,
      ...(groupName ? { groupName } : {}),
      senderGuid: conversation.senderGuid ?? chatIdentifier(chatGuid),
      timestampMs: Date.now(),
      isSms: false,
      isStoredMessage: false,
      verificationFailed: false,
      attachments: [],
      ...control,
    }, this.handles);
  }

  dispatch(type: string, data: unknown): void {
    const event: BlueBubblesEvent = { type, data };
    const webhookIds = this.store
      .listWebhooks()
      .filter((webhook) =>
        webhook.events.includes("*")
        || webhook.events.includes(event.type)
        || (event.type === "imessage-aliases-removed"
          && webhook.events.includes("imessage-alias-removed")),
      )
      .map((webhook) => webhook.id);
    this.store.enqueueWebhookDeliveries(webhookIds, event);
    this.emit("event", event);
    if (webhookIds.length > 0) this.#scheduleWebhookDrain(0);
  }

  #handleAccountStateChanged(state: { users: string; handles: string[] }): void {
    const currentAliases = new Set(
      state.handles.map((handle) => stripTransport(handle).toLowerCase()),
    );
    const removedAliases = [...new Map(
      this.handles
        .map(stripTransport)
        .filter((alias) => !currentAliases.has(alias.toLowerCase()))
        .map((alias) => [alias.toLowerCase(), alias]),
    ).values()];

    // Update the in-memory view immediately. Waiting for the queued snapshot
    // RPC can otherwise emit the same removal twice when IDS publishes two
    // refreshes back-to-back, and can briefly classify inbound traffic using a
    // sending alias Apple has already removed.
    if (this.#snapshot) {
      this.#snapshot = {
        ...this.#snapshot,
        users: state.users,
        handles: [...state.handles],
      };
    }
    if (removedAliases.length > 0) {
      this.dispatch("imessage-aliases-removed", { aliases: removedAliases });
    }
    this.scheduleSnapshot();
  }

  async stop(): Promise<void> {
    await this.scheduler.stop();
    await this.#saveChain;
    if (this.#snapshot) {
      this.#snapshot = await this.engine.snapshot();
      await this.sessionStore.save(this.#snapshot);
    }
    try {
      await this.engine.close();
    } finally {
      // Closing the engine prevents new APNs notifications. Drain a live set,
      // not a one-time snapshot, so handlers added during native shutdown also
      // finish before the caller closes the profile database.
      while (this.#incomingTasks.size > 0) {
        await Promise.allSettled([...this.#incomingTasks]);
      }
      await this.#saveChain;
      await this.#stopWebhookWorker();
    }
  }

  async #handleIncoming(message: IncomingMessage): Promise<void> {
    if (message.readReceipt || message.delivered || message.error) {
      this.#handleOutgoingControl(message);
      return;
    }
    const eventKey = this.store.claimIncomingEvent(message);
    if (!eventKey) return;
    try {
      await this.#handleClaimedIncoming(message);
      this.store.completeIncomingEvent(eventKey);
    } catch (error) {
      // Do not permanently suppress a replay when local attachment persistence,
      // SQLite, or webhook queueing failed before the event was completed.
      this.store.releaseIncomingEvent(eventKey);
      throw error;
    }
  }

  async #handleClaimedIncoming(message: IncomingMessage): Promise<void> {
    const chatGuid = deriveIncomingChatGuid(message, this.handles);
    const previousParticipants = this.store.conversationForChat(chatGuid)?.participants ?? [];
    const verification = message.verificationFailed === undefined
      ? {}
      : { iBlue: { senderVerificationFailed: message.verificationFailed } };
    if (message.sharedProfile && message.sender) {
      const contact = this.store.upsertNameAndPhotoContact(message.sender, message.sharedProfile);
      if (contact) this.dispatch("iblue-contact-updated", contact);
    }
    if (isSharedProfileOnly(message)) return;
    if (message.typing) {
      this.dispatch("typing-indicator", { display: message.typing.active, guid: chatGuid, ...verification });
      return;
    }
    if (message.markUnread) {
      const targetChatGuid = this.store.getMessage(message.uuid)?.chats?.[0]?.guid ?? chatGuid;
      this.store.markChatUnread(targetChatGuid);
      this.dispatch("chat-read-status-changed", { chatGuid: targetChatGuid, read: false, ...verification });
      this.scheduleSnapshot();
      return;
    }
    if (message.notifyAnyway) {
      const updated = this.store.markMessageNotified(message.uuid);
      if (updated) this.dispatch("updated-message", updated);
      this.scheduleSnapshot();
      return;
    }
    let normalizedMessage = withoutSharedProfileAvatar(message);
    if (message.participantChange && !message.participantChange.action) {
      const before = new Map(previousParticipants.map((value) => [stripTransport(value).toLowerCase(), value]));
      const after = new Map(message.participantChange.participants.map((value) => [stripTransport(value).toLowerCase(), value]));
      const added = [...after].filter(([key]) => !before.has(key));
      const removed = [...before].filter(([key]) => !after.has(key));
      const sender = message.sender ? stripTransport(message.sender).toLowerCase() : undefined;
      const action = added.length > 0
        ? "add" as const
        : sender && removed.some(([key]) => key === sender)
          ? "leave" as const
          : removed.length > 0
            ? "remove" as const
            : undefined;
      const changedAddress = action === "add"
        ? added[0]?.[1]
        : action === "leave"
          ? message.sender
          : removed[0]?.[1];
      if (action) {
        normalizedMessage = {
          ...message,
          participantChange: {
            ...message.participantChange,
            action,
            ...(changedAddress ? { changedAddress } : {}),
          },
        };
      }
    }
    const serialized = await this.store.ingestIncoming(normalizedMessage, this.handles);
    if ((normalizedMessage.edit || normalizedMessage.unsend || normalizedMessage.error)) {
      this.dispatch(normalizedMessage.error ? "message-send-error" : "updated-message", serialized);
    } else if (normalizedMessage.groupRename) {
      this.dispatch("group-name-change", serialized);
    } else if (normalizedMessage.participantChange) {
      const action = normalizedMessage.participantChange.action;
      this.dispatch(action === "add"
        ? "participant-added"
        : action === "leave"
          ? "participant-left"
          : "participant-removed", serialized);
    } else if (normalizedMessage.groupIconChange) {
      const cleared = normalizedMessage.groupIconChange.cleared;
      this.dispatch(cleared ? "group-icon-removed" : "group-icon-changed", serialized);
    } else {
      this.dispatch("new-message", serialized);
    }
    this.scheduleSnapshot();
  }

  #scheduleWebhookDrain(delayMs: number): void {
    if (!this.#webhookStarted || this.#webhookStopping) return;
    if (this.#webhookDrain) {
      this.#webhookWakeRequested = true;
      return;
    }
    const target = Date.now() + Math.max(0, delayMs);
    if (this.#webhookTimer && this.#webhookTimerAt !== undefined && this.#webhookTimerAt <= target) {
      return;
    }
    if (this.#webhookTimer) clearTimeout(this.#webhookTimer);
    this.#webhookTimerAt = target;
    this.#webhookTimer = setTimeout(() => {
      this.#webhookTimer = undefined;
      this.#webhookTimerAt = undefined;
      void this.#runWebhookDrain().catch((error) => this.emit("error", error));
    }, Math.max(0, target - Date.now()));
    this.#webhookTimer.unref?.();
  }

  async #runWebhookDrain(): Promise<void> {
    if (!this.#webhookStarted || this.#webhookStopping) return;
    if (this.#webhookDrain) {
      this.#webhookWakeRequested = true;
      return this.#webhookDrain;
    }

    const drain = (async () => {
      while (this.#webhookStarted && !this.#webhookStopping) {
        const deliveries = this.store.dueWebhookDeliveries(Date.now(), 8);
        if (deliveries.length === 0) break;
        await Promise.all(deliveries.map(async (delivery) => {
          try {
            const response = await fetch(delivery.url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-iblue-webhook-delivery-id": String(delivery.id),
                "x-iblue-webhook-event": delivery.eventType,
              },
              body: JSON.stringify(delivery.payload),
              signal: AbortSignal.timeout(this.#webhookTimeoutMs),
            });
            await response.body?.cancel().catch(() => undefined);
            if (!response.ok) {
              throw new Error(`webhook returned HTTP ${response.status}: ${delivery.url}`);
            }
            this.store.completeWebhookDelivery(delivery.id);
          } catch (error) {
            const failedAttempts = delivery.attemptCount + 1;
            const terminal = failedAttempts >= this.#webhookMaxAttempts;
            const delay = this.#webhookRetryDelaysMs[
              Math.min(failedAttempts - 1, this.#webhookRetryDelaysMs.length - 1)
            ] ?? 60 * 60_000;
            this.store.recordWebhookDeliveryFailure({
              id: delivery.id,
              error: error instanceof Error ? error.message : String(error),
              nextAttemptAt: Date.now() + delay,
              terminal,
            });
            this.emit("log", {
              level: terminal ? "error" : "warn",
              message: terminal
                ? `Webhook delivery ${delivery.id} exhausted ${failedAttempts} attempts: ${String(error)}`
                : `Webhook delivery ${delivery.id} failed attempt ${failedAttempts}; retrying: ${String(error)}`,
            });
          }
        }));
      }
    })();

    this.#webhookDrain = drain;
    try {
      await drain;
    } finally {
      this.#webhookDrain = undefined;
      if (this.#webhookStarted && !this.#webhookStopping) {
        if (this.#webhookWakeRequested) {
          this.#webhookWakeRequested = false;
          this.#scheduleWebhookDrain(0);
        } else {
          const next = this.store.nextWebhookDeliveryAt();
          if (next !== undefined) this.#scheduleWebhookDrain(Math.max(0, next - Date.now()));
        }
      }
    }
  }

  async #stopWebhookWorker(): Promise<void> {
    this.#webhookStopping = true;
    this.#webhookStarted = false;
    if (this.#webhookTimer) clearTimeout(this.#webhookTimer);
    this.#webhookTimer = undefined;
    this.#webhookTimerAt = undefined;
    await this.#webhookDrain;
    this.#webhookWakeRequested = false;
  }
}

function isSharedProfileOnly(message: IncomingMessage): boolean {
  return Boolean(
    message.sharedProfile
    && !message.text
    && !message.subject
    && message.attachments.length === 0
    && !message.tapback
    && !message.edit
    && !message.unsend
    && !message.typing
    && !message.groupRename
    && !message.participantChange
    && !message.groupIconChange
    && !message.markUnread
    && !message.notifyAnyway
    && !message.appBalloon,
  );
}

function liveLocationFromFollow(follow: NativeFindMyFollow, now: number): IBlueLiveLocation {
  const location = follow.lastLocation;
  const expiresAt = follow.expires > 0 ? follow.expires : null;
  const address = follow.invitationAcceptedHandles[0]
    ?? follow.invitationFromHandles[0]
    ?? follow.id;
  return {
    source: "find-my",
    followId: follow.id,
    address: stripTransport(address),
    acceptedHandles: follow.invitationAcceptedHandles.map(stripTransport),
    fromHandles: follow.invitationFromHandles.map(stripTransport),
    isActive: expiresAt === null || expiresAt > now,
    isFromMessages: follow.isFromMessages,
    locatingInProgress: follow.locateInProgress,
    expiresAt,
    sharingUpdatedAt: follow.updateTimestamp,
    ...(location ? {
      latitude: location.latitude,
      longitude: location.longitude,
      altitude: location.altitude,
      horizontalAccuracy: location.horizontalAccuracy,
      verticalAccuracy: location.verticalAccuracy,
      locationUpdatedAt: location.timestamp,
      isInaccurate: location.isInaccurate,
      ...(location.isOld === undefined || location.isOld === null ? {} : { isOld: location.isOld }),
      ...(location.formattedAddressLines?.length
        ? { formattedAddress: location.formattedAddressLines.join("\n") }
        : {}),
      ...(location.locality ? { locality: location.locality } : {}),
      ...(location.stateCode ? { stateCode: location.stateCode } : {}),
      ...(location.countryCode ? { countryCode: location.countryCode } : {}),
    } : {}),
  };
}

function withoutSharedProfileAvatar(message: IncomingMessage): IncomingMessage {
  if (!message.sharedProfile?.avatarBase64) return message;
  const { avatarBase64: _avatarBase64, ...sharedProfile } = message.sharedProfile;
  return { ...message, sharedProfile };
}

function nullReactionText(reaction: BlueBubblesReaction): string {
  const removed = reaction.startsWith("-");
  const name = reaction.replace(/^-/, "");
  return `${removed ? "Removed" : "Sent"} ${name} reaction`;
}

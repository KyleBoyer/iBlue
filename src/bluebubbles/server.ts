import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { networkInterfaces, platform, release, tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { deflateSync } from "node:zlib";

import cors from "@fastify/cors";
import multipart, { type MultipartFile, type MultipartValue } from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
} from "fastify";
import { Server as SocketIoServer, type Socket } from "socket.io";

import type {
  BlueBubblesResponse,
  BlueBubblesScheduleInterval,
  IBlueContactCardAddress,
  IBlueContactCardField,
  IBlueContactCardInput,
  IBlueContactCardSocialProfile,
  IBlueICloudShareVariantName,
  IBlueReactionRequest,
} from "./contracts.js";
import type { NativeFaceTimeMediaFrame } from "../types.js";
import type { FaceTimeIncomingSession } from "../native/engine.js";
import { failure, success, unsupported } from "./response.js";
import type { ScheduledMessageDraft } from "./scheduler.js";
import {
  BlueBubblesService,
  StickerUnsendUnsupportedError,
  type BlueBubblesEvent,
} from "./service.js";
import { stripTransport, toTransportAddress } from "./guid.js";
import { buildVCardContact, parseVCardContactCards, parseVCardContacts } from "./contact.js";
import { effectIdForMessageFlair, MESSAGE_FLAIRS } from "./message-flair.js";
import {
  assertSingleEmoji,
  htmlFromTextRuns,
  IBLUE_TEXT_EFFECTS,
  IBLUE_TEXT_STYLES,
  parseOutboundTextRuns,
} from "./attributed-text.js";
import { documentApiRoute } from "./openapi.js";
import {
  ICloudShareError,
  ICloudShareResolver,
  iCloudSharePresentation,
  publicICloudShare,
} from "./icloud-share.js";
import {
  IBLUE_BUILTIN_CONVERSATION_BACKGROUNDS,
  isBuiltinConversationBackgroundPreset,
  normalizeConversationBackgroundColors,
} from "./backgrounds.js";
import {
  FaceTimeMediaManager,
  type FaceTimeMediaMode,
} from "./facetime-media.js";

const WEBHOOK_EVENTS = new Set([
  "*",
  "new-message",
  "updated-message",
  "message-send-error",
  "group-name-change",
  "group-icon-changed",
  "group-icon-removed",
  "participant-removed",
  "participant-added",
  "participant-left",
  "chat-read-status-changed",
  "typing-indicator",
  // BlueBubbles 1.9.9's webhook picker/validator uses the singular spelling,
  // while its actual Private API/Socket.IO event is plural. Accept both and
  // bridge the singular subscription in BlueBubblesService.
  "imessage-alias-removed",
  "imessage-aliases-removed",
  "iblue-contact-updated",
  "iblue-contacts-synced",
  "iblue-focus-updated",
  "iblue-focus-keys-received",
  "iblue-focus-reshare-received",
  "iblue-focus-decrypt-failed",
  "iblue-message-receipt",
  "iblue-conversation-background-changed",
  "scheduled-message-created",
  "scheduled-message-updated",
  "scheduled-message-deleted",
  "scheduled-message-sent",
  "scheduled-message-error",
  // Accepted by BlueBubbles' official webhook picker even when the associated
  // optional iBlue subsystem is unavailable and therefore never emits them.
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
  "hello-world",
]);

// These are deliberately separate versions. BlueBubbles clients parse
// `server_version` as semver and use it as their API feature gate; branding the
// value (for example, `iBlue/0.1.0`) makes the official client throw during
// setup. Keep iBlue's implementation version in the additive metadata below.
const IBLUE_VERSION = "0.1.0";
const BLUEBUBBLES_COMPAT_VERSION = "1.9.9";
const BLUEBUBBLES_COMPAT_COMMIT = "f2e2286241a7c3b6617a82b37d4afaab4df3a6b9";

export function derivePublicComputerId(profile: string, deviceId: string | undefined): string {
  const bytes = createHash("sha256")
    .update("iblue:bluebubbles-computer-id:v1\0")
    .update(profile)
    .update("\0")
    .update(deviceId ?? "")
    .digest()
    .subarray(0, 16);

  // Preserve the UUID shape clients expect without publishing the hardware
  // UUID that the native Apple registration protocol must retain internally.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function localAddresses(family: "IPv4" | "IPv6"): string[] {
  return Object.values(networkInterfaces()).flatMap((addresses) =>
    (addresses ?? [])
      .filter((address) =>
        address.family === family
        && !address.internal
        && address.mac !== "00:00:00:00:00:00")
      .map((address) => address.address),
  );
}

export interface BlueBubblesServerOptions {
  service: BlueBubblesService;
  host?: string;
  port?: number;
  /** Test/embedding override for Apple's public iCloud Photos resolver. */
  icloudShareResolver?: ICloudShareResolver;
  /** Test/embedding override for the deterministic FaceTime call controller. */
  faceTimeMediaManager?: FaceTimeMediaController;
}

type FaceTimeMediaController =
  Pick<FaceTimeMediaManager, "list" | "get" | "start" | "stop" | "close">
  & Partial<Pick<
    FaceTimeMediaManager,
    "answerIncoming" | "startLiveAudio" | "pushLiveAudioFrame" | "finishLiveAudio"
  >>;

type Query = Record<string, string | undefined>;

interface SocketUpload {
  directory: string;
  path: string;
  chatGuid: string;
  tempGuid: string;
  nextOffset: number;
}

interface FaceTimeSocketSubscription {
  subscriptionId: string;
  callId?: string;
  sessionId: string;
  audio: boolean;
  video: boolean;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface FaceTimeAutoAnswerArm {
  id: string;
  directory: string;
  sourcePath: string;
  filename: string;
  mimeType: string;
  size: number;
  mode: FaceTimeMediaMode;
  caller?: string;
  displayName: string;
  maxDurationSeconds: number;
  createdAt: number;
  expiresAt: number;
  state: "armed" | "answering";
  timer: ReturnType<typeof setTimeout>;
}

type PublicFaceTimeAutoAnswerArm = Omit<
  FaceTimeAutoAnswerArm,
  "directory" | "sourcePath" | "timer"
>;

export class BlueBubblesServer {
  readonly service: BlueBubblesService;
  readonly host: string;
  readonly port: number;
  readonly app: FastifyInstance;
  readonly icloudShareResolver: ICloudShareResolver;

  #socket?: SocketIoServer;
  #faceTimeMedia?: FaceTimeMediaController;
  #faceTimeMediaUnavailableReason?: string;
  readonly #faceTimeSocketSubscriptions = new Map<
    string,
    Map<string, FaceTimeSocketSubscription>
  >();
  /** A live microphone stream is controlled exclusively by the socket that created it. */
  readonly #faceTimeLiveAudioOwners = new Map<string, string>();
  /** Live media on an answered incoming call is controlled by one socket. */
  readonly #faceTimeIncomingLiveOwners = new Map<
    string,
    { socketId: string; audio: boolean; video: boolean }
  >();
  #faceTimeAutoAnswer: FaceTimeAutoAnswerArm | undefined;

  constructor(options: BlueBubblesServerOptions) {
    this.service = options.service;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 1234;
    this.icloudShareResolver = options.icloudShareResolver ?? new ICloudShareResolver();
    this.app = Fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 });
    if (options.faceTimeMediaManager) {
      this.#faceTimeMedia = options.faceTimeMediaManager;
    } else if (this.service.faceTimeAvailable) {
      try {
        this.#faceTimeMedia = new FaceTimeMediaManager({
          signaling: {
            createSession: (params) => this.service.createFaceTimeSession(params),
            listSessions: () => this.service.listFaceTimeSessions(),
            ringSession: (sessionId, targets) =>
              this.service.ringFaceTimeSession(sessionId, targets),
            confirmMediaJoined: (sessionId) =>
              this.service.confirmFaceTimeMediaJoined(sessionId),
            leaveSession: (sessionId) => this.service.leaveFaceTimeSession(sessionId),
            ...(this.service.nativeFaceTimeMediaAvailable ? {
              createNativeMediaSession: (params: {
                targets: string[];
                from?: string;
                audioPath: string;
                videoPath?: string;
                videoDescriptionPath?: string;
                videoFrameDurationMs?: number;
              }) => this.service.createNativeFaceTimeMediaSession(params),
              startNativeMediaSession: (sessionId: string) =>
                this.service.startNativeFaceTimeMediaSession(sessionId),
              nativeMediaStatus: (sessionId: string) =>
                this.service.nativeFaceTimeMediaStatus(sessionId),
            } : {}),
            ...(this.service.nativeFaceTimeIncomingAvailable ? {
              listIncomingSessions: () => this.service.listIncomingFaceTimeSessions(),
              answerIncomingSession: (params: {
                sessionId: string;
                audioPath?: string;
                videoPath?: string;
                videoDescriptionPath?: string;
                videoFrameDurationMs?: number;
              }) => this.service.answerIncomingFaceTimeSession(params),
              declineIncomingSession: (sessionId: string) =>
                this.service.declineIncomingFaceTimeSession(sessionId),
            } : {}),
            ...(this.service.nativeFaceTimeLiveAudioAvailable ? {
              createNativeLiveAudioSession: (params: {
                targets: string[];
                from?: string;
                ring?: boolean;
              }) => this.service.createNativeFaceTimeLiveAudioSession(params),
              startNativeLiveAudioStream: (sessionId: string) =>
                this.service.startNativeFaceTimeLiveAudioStream(sessionId),
              pushNativeLiveAudioFrame: (sessionId: string, frame: Buffer) =>
                this.service.pushNativeFaceTimeLiveAudioFrame(sessionId, frame),
              finishNativeLiveAudioStream: (sessionId: string) =>
                this.service.finishNativeFaceTimeLiveAudioStream(sessionId),
            } : {}),
          },
          onUpdate: (call) => {
            this.service.dispatch("ft-call-status-changed", call);
            if ((call.state === "ended" || call.state === "failed") && call.sessionId) {
              this.#faceTimeLiveAudioOwners.delete(call.id);
              void this.revokeFaceTimeSubscriptions(call.sessionId);
            }
          },
        });
      } catch (error) {
        this.#faceTimeMediaUnavailableReason = error instanceof Error ? error.message : String(error);
      }
    }
  }

  async start(): Promise<{ address: string; port: number }> {
    await this.cleanupStaleMultipartUploads();
    const savedVcf = await this.loadContactsVcf();
    if (savedVcf) this.service.store.replaceProfileVcfContacts(parseVCardContacts(savedVcf));
    await this.app.register(cors, { origin: true });
    await this.app.register(multipart, {
      limits: { fileSize: 1024 * 1024 * 1024, files: 8, fields: 100 },
    });
    await this.configureDocumentation();
    this.configureBodyParsing();
    this.configureAuth();
    this.configureRoutes();
    this.configureErrors();

    this.#socket = new SocketIoServer(this.app.server, {
      pingTimeout: 120_000,
      pingInterval: 60_000,
      upgradeTimeout: 30_000,
      maxHttpBufferSize: 100_000_000,
      allowEIO3: true,
      transports: ["websocket", "polling"],
      cors: { origin: "*" },
    });
    this.configureSocket(this.#socket);
    this.service.on("event", (event: BlueBubblesEvent) => {
      this.#socket?.emit(event.type, event.data);
      if (event.type === "incoming-facetime") {
        void this.tryFaceTimeAutoAnswer(event.data).catch((error) =>
          this.app.log.error(error));
      }
    });
    this.service.on("facetime-media-frame", (frame: NativeFaceTimeMediaFrame) =>
      this.routeFaceTimeMediaFrame(frame));
    this.service.on("error", (error) => this.app.log.error(error));

    const address = await this.app.listen({ host: this.host, port: this.port });
    this.service.dispatch("hello-world", null);
    const parsed = new URL(address);
    return { address, port: Number(parsed.port) };
  }

  async stop(): Promise<void> {
    for (const subscriptions of this.#faceTimeSocketSubscriptions.values()) {
      for (const subscription of subscriptions.values()) clearTimeout(subscription.timer);
    }
    this.#faceTimeSocketSubscriptions.clear();
    await this.clearFaceTimeAutoAnswer();
    await this.#faceTimeMedia?.close();
    await new Promise<void>((resolve) => {
      if (!this.#socket) return resolve();
      this.#socket.close(() => resolve());
    });
    await this.app.close();
  }

  private async configureDocumentation(): Promise<void> {
    await this.app.register(swagger, {
      openapi: {
        openapi: "3.1.0",
        info: {
          title: "iBlue API",
          version: IBLUE_VERSION,
          description: "BlueBubbles-compatible REST API with additive iBlue endpoints for iCloud sync, contacts, Focus, live locations, message components, effects, backgrounds, polls, rich links, and iCloud Photos shares.",
        },
        tags: [
          { name: "Server", description: "Server health, metadata, and statistics." },
          { name: "Messages", description: "BlueBubbles-compatible message operations." },
          { name: "Chats", description: "BlueBubbles-compatible chat operations." },
          { name: "Attachments", description: "Attachment upload and download operations." },
          { name: "Handles", description: "iMessage handle lookup and availability." },
          { name: "Contacts", description: "Stock BlueBubbles contact compatibility routes." },
          { name: "FCM", description: "BlueBubbles Firebase compatibility status." },
          { name: "Webhooks", description: "Webhook registration and management." },
          { name: "iBlue Contacts", description: "Profile-local contact names, VCF data, and avatars." },
          { name: "iBlue Cloud Sync", description: "Read-only paginated Messages in iCloud synchronization." },
          { name: "iBlue Focus", description: "StatusKit Focus subscriptions and sharing." },
          { name: "iBlue Messages", description: "Message effects and rich app content." },
          { name: "iBlue Locations", description: "Static and live shared-location data." },
          { name: "iBlue Polls", description: "Native Messages polls and votes." },
          { name: "iBlue iCloud Photos", description: "Resolve, create, download, and send iCloud Photos shares." },
          { name: "iBlue FaceTime", description: "Profile-isolated FaceTime signaling, media, lifecycle, and agent-facing realtime streams." },
          { name: "iBlue Extensions", description: "Additional iBlue API extensions." },
        ],
        components: {
          securitySchemes: {
            serverPassword: {
              type: "apiKey",
              in: "query",
              name: "password",
              description: "The configured iBlue server password. BlueBubbles aliases `guid` and `token` are also accepted by the API.",
            },
          },
        },
        security: [{ serverPassword: [] }],
      },
      transform: ({ schema, url, route }) => ({
        schema: documentApiRoute(schema, url, route.method),
        url,
      }),
    });
    await this.app.register(swaggerUi, {
      routePrefix: "/docs",
      staticCSP: true,
      theme: { title: "iBlue API Documentation" },
      uiConfig: {
        deepLinking: true,
        docExpansion: "list",
        persistAuthorization: true,
        displayRequestDuration: true,
        filter: true,
      },
    });
    this.app.get("/openapi.json", { schema: { hide: true } }, async () => this.app.swagger());
  }

  // BlueBubbles clients send payload-free actions — typing, read receipts —
  // as a JSON-typed POST with no body at all. Express accepts that; Fastify's
  // default parser rejects an empty body outright, which surfaced as a 500 on
  // /chat/:guid/typing. Treat an empty JSON body as an empty object, which is
  // what every route's `asRecord` already expects.
  private configureBodyParsing(): void {
    this.app.addContentTypeParser<string>(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => {
        const text = body.trim();
        if (text.length === 0) return done(null, {});
        try {
          done(null, JSON.parse(text));
        } catch {
          done(new RequestError(400, "Invalid JSON body", "VALIDATION_ERROR"), undefined);
        }
      },
    );
  }

  private configureAuth(): void {
    this.app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/api/v1")) return;
      const query = request.query as Query;
      const token = query.guid ?? query.password ?? query.token;
      if (!token || safeDecode(token).trim() !== this.service.password.trim()) {
        const response = failure(
          401,
          "You are not authorized to access this resource",
          "Authentication Error",
          token ? "Unauthorized" : "Missing server password!",
        );
        await reply.code(401).send(response);
      }
    });
  }

  private configureRoutes(): void {
    this.app.get("/api/v1/ping", async () => success("pong", "Ping received!"));
    this.app.get("/api/v1/server/info", async () => success(this.serverMetadata()));
    // The official client checks for an Electron server update shortly after
    // setup. iBlue is updated as its own application, so "no update" is the
    // honest capability response; installing an update remains unsupported.
    this.app.get("/api/v1/server/update/check", async () =>
      success({ available: false, metadata: {} }, "Successfully checked for updates!"),
    );

    this.app.get<{ Querystring: Query }>("/api/v1/server/statistics/totals", async (request) => {
      const only = statisticsOnly(request.query.only, ["handle", "message", "chat", "attachment"]);
      const data: Record<string, number> = {};
      if (only.has("handle")) {
        data.handles = this.service.store.queryHandles({ additionalAddresses: this.service.handles }).total;
      }
      if (only.has("message")) data.messages = this.service.store.countMessages();
      if (only.has("chat")) data.chats = this.service.store.countChats().total;
      if (only.has("attachment")) data.attachments = this.service.store.countAttachments();
      return success(data);
    });
    this.app.get<{ Querystring: Query }>("/api/v1/server/statistics/media", async (request) => {
      const only = statisticsOnly(request.query.only, ["image", "video", "location"]);
      const totals = this.service.store.mediaTotals();
      const data: Record<string, number> = {};
      if (only.has("image")) data.images = totals.images;
      if (only.has("video")) data.videos = totals.videos;
      if (only.has("location")) data.locations = totals.locations;
      return success(data);
    });
    this.app.get<{ Querystring: Query }>("/api/v1/server/statistics/media/chat", async (request) => {
      const only = statisticsOnly(request.query.only, ["image", "video", "location"]);
      const data = this.service.store.mediaTotalsByChat().flatMap((entry) => {
        const totals: Record<string, number> = {};
        if (only.has("image")) totals.images = entry.totals.images;
        if (only.has("video")) totals.videos = entry.totals.videos;
        if (only.has("location")) totals.locations = entry.totals.locations;
        return Object.values(totals).some((count) => count > 0)
          ? [{ chatGuid: entry.chatGuid, groupName: entry.groupName, totals }]
          : [];
      });
      return success(data);
    });

    this.app.get("/api/v1/chat/count", async () => success(this.service.store.countChats()));
    this.app.get("/api/v1/attachment/count", async () =>
      success({ total: this.service.store.countAttachments() }),
    );
    this.app.post("/api/v1/attachment/upload", async (request) => {
      const file = await request.file();
      if (!file || file.fieldname !== "attachment") {
        throw new RequestError(400, "Attachment not provided or was empty!", "VALIDATION_ERROR");
      }
      const uploadId = randomUUID();
      const directory = join(this.multipartUploadRoot(), uploadId);
      const name = safeAttachmentName(file.filename);
      const path = join(directory, name);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        if (await saveMultipartFile(file, path) === 0) {
          throw new RequestError(400, "Attachment not provided or was empty!", "VALIDATION_ERROR");
        }
        return success({ path: `${uploadId}/${name}` });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    });
    this.app.get("/api/v1/handle/count", async () =>
      success({ total: this.service.store.queryHandles({ additionalAddresses: this.service.handles }).total }),
    );
    this.app.get<{ Querystring: Query }>("/api/v1/message/count", async (request) =>
      success({ total: this.messageCount(request.query) }),
    );
    this.app.get<{ Querystring: Query }>("/api/v1/message/count/updated", async (request) =>
      success({ total: this.messageCount(request.query, { updated: true }) }),
    );
    this.app.get<{ Querystring: Query }>("/api/v1/message/count/me", async (request) =>
      success({ total: this.messageCount(request.query, { isFromMe: true }) }),
    );

    this.app.post("/api/v1/handle/query", async (request) => {
      const body = asRecord(request.body);
      const offset = numberValue(body.offset, 0);
      const limit = numberValue(body.limit, 100);
      const result = this.service.store.queryHandles({
        ...(typeof body.address === "string" ? { address: body.address } : {}),
        offset,
        limit,
        additionalAddresses: this.service.handles,
      });
      return success(result.handles, "Successfully fetched handles!", {
        total: result.total,
        offset,
        limit,
        count: result.handles.length,
      });
    });
    this.app.get<{ Querystring: Query }>("/api/v1/handle/availability/imessage", async (request) => {
      const address = request.query.address;
      if (!address) throw new RequestError(400, "address is required", "VALIDATION_ERROR");
      return success({ available: await this.service.isIMessageAvailable(address) });
    });
    this.app.get<{ Params: { guid: string } }>("/api/v1/handle/:guid", async (request, reply) => {
      const handle = this.service.store.getHandle(request.params.guid, this.service.handles);
      if (!handle) return reply.code(404).send(notFound("Handle not found!"));
      return success(handle);
    });
    this.app.get<{ Params: { guid: string } }>("/api/v1/handle/:guid/focus", async (request) => {
      const handle = stripTransport(request.params.guid);
      await this.service.subscribeFocus([handle]);
      return success(this.service.focusForHandle(handle) ?? {
        handle,
        available: null,
        notificationsSilenced: null,
        mode: null,
        updatedAt: null,
        subscribed: true,
      }, "Successfully subscribed to Focus status!");
    });
    this.app.get<{ Querystring: Query }>("/api/v1/handle/availability/facetime", async (request) => {
      if (!request.query.address) throw new RequestError(400, "address is required", "VALIDATION_ERROR");
      return success({ available: this.service.faceTimeAvailable });
    });

    this.app.post("/api/v1/iblue/facetime/session", async (request) => {
      const body = asRecord(request.body);
      const targets = Array.isArray(body.targets)
        ? body.targets.filter((value): value is string => typeof value === "string")
        : typeof body.address === "string"
          ? [body.address]
          : [];
      if (targets.length === 0) {
        throw new RequestError(400, "address or targets is required", "VALIDATION_ERROR");
      }
      const normalizedTargets = targets.map((target) => {
        const trimmed = target.trim();
        if (trimmed.startsWith("tel:") || trimmed.startsWith("mailto:")) return trimmed;
        return toTransportAddress(trimmed);
      });
      const ttl = body.ringTtlSeconds === undefined
        ? undefined
        : numberValue(body.ringTtlSeconds, Number.NaN);
      if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 15 || ttl > 3_600)) {
        throw new RequestError(
          400,
          "ringTtlSeconds must be an integer between 15 and 3600",
          "VALIDATION_ERROR",
        );
      }
      const result = await this.service.createFaceTimeSession({
        targets: normalizedTargets,
        ...(typeof body.from === "string" ? { from: toTransportAddress(body.from) } : {}),
        ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
        ...(ttl === undefined ? {} : { ringTtlSeconds: ttl }),
      });
      this.service.dispatch("ft-call-status-changed", {
        callUuid: result.sessionId,
        status: result.state,
        targets: result.targets,
      });
      return success(result, "FaceTime session created; join its link to begin ringing!");
    });
    this.app.get("/api/v1/iblue/facetime/session", async () =>
      success(await this.service.listFaceTimeSessions(), "Successfully fetched FaceTime sessions!"));
    this.app.post<{ Params: { sessionId: string } }>(
      "/api/v1/iblue/facetime/session/:sessionId/leave",
      async (request) => {
        const result = await this.service.leaveFaceTimeSession(request.params.sessionId);
        this.service.dispatch("ft-call-status-changed", {
          callUuid: result.sessionId,
          status: "ended",
        });
        return success(result, "FaceTime session left!");
      },
    );
    this.app.get("/api/v1/iblue/facetime/incoming", async () => success(
      await this.service.listIncomingFaceTimeSessions(),
      "Successfully fetched incoming FaceTime sessions!",
    ));
    this.app.get("/api/v1/iblue/facetime/incoming/auto-answer", async () => {
      const arm = this.#faceTimeAutoAnswer;
      if (arm && arm.expiresAt <= Date.now()) await this.clearFaceTimeAutoAnswer(arm);
      return success(
        this.#faceTimeAutoAnswer ? publicFaceTimeAutoAnswerArm(this.#faceTimeAutoAnswer) : null,
        this.#faceTimeAutoAnswer
          ? "FaceTime auto-answer is armed!"
          : "FaceTime auto-answer is not armed.",
      );
    });
    this.app.post("/api/v1/iblue/facetime/incoming/auto-answer", async (request) => {
      if (!this.#faceTimeMedia?.answerIncoming) {
        throw new RequestError(
          500,
          this.#faceTimeMediaUnavailableReason ?? "Incoming FaceTime media is unavailable",
          "FACETIME_MEDIA_UNAVAILABLE",
        );
      }
      if (this.#faceTimeAutoAnswer?.state === "answering") {
        throw new RequestError(
          409,
          "FaceTime auto-answer is already answering a call",
          "INVALID_STATE",
        );
      }
      const file = await request.file();
      if (!file || file.fieldname !== "media") {
        throw new RequestError(400, "FaceTime media file is required", "VALIDATION_ERROR");
      }
      const directory = await mkdtemp(join(tmpdir(), "iblue-facetime-auto-answer-upload-"));
      const filename = safeAttachmentName(file.filename || "media");
      const sourcePath = join(directory, filename);
      let installed = false;
      try {
        const size = await saveMultipartFile(file, sourcePath);
        if (size === 0 || size > 95 * 1024 * 1024) {
          throw new RequestError(
            400,
            "FaceTime media must be between 1 byte and 95 MiB",
            "VALIDATION_ERROR",
          );
        }
        const requestedMode = multipartField(file, "mode");
        const inferredMode = file.mimetype.startsWith("audio/")
          ? "audio"
          : file.mimetype.startsWith("video/")
            ? "video"
            : undefined;
        if (requestedMode !== undefined && requestedMode !== "audio" && requestedMode !== "video") {
          throw new RequestError(400, "mode must be audio or video", "VALIDATION_ERROR");
        }
        const mode = (requestedMode ?? inferredMode) as FaceTimeMediaMode | undefined;
        if (!mode) {
          throw new RequestError(
            400,
            "mode is required when the upload is not identified as audio or video",
            "VALIDATION_ERROR",
          );
        }
        if (inferredMode && inferredMode !== mode) {
          throw new RequestError(
            400,
            `The uploaded ${inferredMode} file cannot arm a FaceTime ${mode} call`,
            "VALIDATION_ERROR",
          );
        }
        const rawDuration = multipartField(file, "maxDurationSeconds");
        const maxDurationSeconds = rawDuration === undefined ? 90 : Number(rawDuration);
        if (
          !Number.isSafeInteger(maxDurationSeconds)
          || maxDurationSeconds < 15
          || maxDurationSeconds > 600
        ) {
          throw new RequestError(
            400,
            "maxDurationSeconds must be an integer between 15 and 600",
            "VALIDATION_ERROR",
          );
        }
        const rawExpiry = multipartField(file, "expiresInSeconds");
        const expiresInSeconds = rawExpiry === undefined ? 300 : Number(rawExpiry);
        if (
          !Number.isSafeInteger(expiresInSeconds)
          || expiresInSeconds < 15
          || expiresInSeconds > 86_400
        ) {
          throw new RequestError(
            400,
            "expiresInSeconds must be an integer between 15 and 86400",
            "VALIDATION_ERROR",
          );
        }
        const rawCaller = multipartField(file, "caller")?.trim();
        if (rawCaller === "") {
          throw new RequestError(400, "caller must not be empty", "VALIDATION_ERROR");
        }
        const now = Date.now();
        const arm: FaceTimeAutoAnswerArm = {
          id: randomUUID(),
          directory,
          sourcePath,
          filename,
          mimeType: file.mimetype,
          size,
          mode,
          ...(rawCaller ? { caller: normalizeFaceTimeAddress(rawCaller) } : {}),
          displayName: multipartField(file, "displayName")?.trim() || "iBlue",
          maxDurationSeconds,
          createdAt: now,
          expiresAt: now + expiresInSeconds * 1_000,
          state: "armed",
          timer: setTimeout(() => {
            void this.clearFaceTimeAutoAnswer(arm).catch((error) => this.app.log.error(error));
          }, expiresInSeconds * 1_000),
        };
        const previous = this.#faceTimeAutoAnswer;
        this.#faceTimeAutoAnswer = arm;
        installed = true;
        if (previous) await this.clearFaceTimeAutoAnswer(previous);
        return success(
          publicFaceTimeAutoAnswerArm(arm),
          "The next matching incoming FaceTime call will be answered automatically!",
        );
      } finally {
        if (!installed) await rm(directory, { recursive: true, force: true });
      }
    });
    this.app.delete("/api/v1/iblue/facetime/incoming/auto-answer", async () => {
      const arm = this.#faceTimeAutoAnswer;
      if (arm?.state === "answering") {
        throw new RequestError(
          409,
          "FaceTime auto-answer has already claimed a call",
          "INVALID_STATE",
        );
      }
      await this.clearFaceTimeAutoAnswer(arm);
      return success({ disarmed: Boolean(arm) }, "FaceTime auto-answer disarmed!");
    });
    this.app.post<{ Params: { sessionId: string } }>(
      "/api/v1/iblue/facetime/incoming/:sessionId/answer",
      async (request) => {
        const session = await this.service.answerIncomingFaceTimeSession({
          sessionId: request.params.sessionId,
        });
        this.service.dispatch("ft-call-status-changed", {
          ...session,
          direction: "incoming",
          status: "active",
        });
        return success(session, "Incoming FaceTime call answered!");
      },
    );
    this.app.post<{ Params: { sessionId: string } }>(
      "/api/v1/iblue/facetime/incoming/:sessionId/answer-with-media",
      async (request) => {
        if (!this.#faceTimeMedia?.answerIncoming) {
          throw new RequestError(
            500,
            this.#faceTimeMediaUnavailableReason ?? "Incoming FaceTime media is unavailable",
            "FACETIME_MEDIA_UNAVAILABLE",
          );
        }
        const file = await request.file();
        if (!file || file.fieldname !== "media") {
          throw new RequestError(400, "FaceTime media file is required", "VALIDATION_ERROR");
        }
        const directory = await mkdtemp(join(tmpdir(), "iblue-facetime-incoming-upload-"));
        const filename = safeAttachmentName(file.filename || "media");
        const path = join(directory, filename);
        try {
          const size = await saveMultipartFile(file, path);
          if (size === 0 || size > 95 * 1024 * 1024) {
            throw new RequestError(
              400,
              "FaceTime media must be between 1 byte and 95 MiB",
              "VALIDATION_ERROR",
            );
          }
          const incoming = (await this.service.listIncomingFaceTimeSessions())
            .find((session) => session.sessionId === request.params.sessionId);
          if (!incoming) {
            throw new RequestError(404, "Incoming FaceTime session was not found", "NOT_FOUND");
          }
          if (incoming.state !== "ringing") {
            throw new RequestError(
              409,
              `Incoming FaceTime session is not ringing (${incoming.state})`,
              "INVALID_STATE",
            );
          }
          if (!file.mimetype.startsWith(`${incoming.mode}/`)) {
            throw new RequestError(
              400,
              `The incoming FaceTime ${incoming.mode} call requires an ${incoming.mode} media upload`,
              "VALIDATION_ERROR",
            );
          }
          const rawDuration = multipartField(file, "maxDurationSeconds");
          const maxDurationSeconds = rawDuration === undefined ? undefined : Number(rawDuration);
          if (maxDurationSeconds !== undefined && (
            !Number.isSafeInteger(maxDurationSeconds)
            || maxDurationSeconds < 15
            || maxDurationSeconds > 600
          )) {
            throw new RequestError(
              400,
              "maxDurationSeconds must be an integer between 15 and 600",
              "VALIDATION_ERROR",
            );
          }
          const nativeAudioPassthrough = multipartField(file, "nativeAudioPassthrough") === "true";
          if (nativeAudioPassthrough && incoming.mode !== "audio") {
            throw new RequestError(
              400,
              "nativeAudioPassthrough is available only for FaceTime Audio",
              "VALIDATION_ERROR",
            );
          }
          const nativeVideoPassthrough = multipartField(file, "nativeVideoPassthrough") === "true";
          if (nativeVideoPassthrough && incoming.mode !== "video") {
            throw new RequestError(
              400,
              "nativeVideoPassthrough is available only for FaceTime Video",
              "VALIDATION_ERROR",
            );
          }
          const call = await this.#faceTimeMedia.answerIncoming({
            sessionId: request.params.sessionId,
            displayName: multipartField(file, "displayName") ?? "iBlue",
            sourcePath: path,
            ...(maxDurationSeconds === undefined ? {} : { maxDurationSeconds }),
            ...(nativeAudioPassthrough ? { nativeAudioPassthrough: true } : {}),
            ...(nativeVideoPassthrough ? { nativeVideoPassthrough: true } : {}),
          });
          return success(call, "Incoming FaceTime call is answering with deterministic media!");
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
    this.app.post<{ Params: { sessionId: string } }>(
      "/api/v1/iblue/facetime/incoming/:sessionId/decline",
      async (request) => {
        const session = await this.service.declineIncomingFaceTimeSession(request.params.sessionId);
        this.service.dispatch("ft-call-status-changed", {
          ...session,
          direction: "incoming",
          status: "declined",
        });
        return success(session, "Incoming FaceTime call declined!");
      },
    );
    this.app.get("/api/v1/iblue/facetime/capabilities", async () => success({
      signaling: this.service.faceTimeAvailable,
      deterministicMedia: Boolean(this.#faceTimeMedia),
      // These legacy scalar fields describe the preferred audio path. Use
      // modeCapabilities when selecting audio versus video behavior.
      deterministicMediaTransport: this.service.nativeFaceTimeMediaAvailable
        ? "iblue-quickrelay"
        : this.#faceTimeMedia
          ? "apple-web-bridge"
          : null,
      nativeMedia: this.service.nativeFaceTimeMediaAvailable,
      nativeMediaModes: this.service.nativeFaceTimeMediaAvailable ? ["audio", "video"] : [],
      experimentalNativeMediaModes: [],
      nativeMediaUnavailableReason: this.service.nativeFaceTimeMediaAvailable
        ? null
        : this.service.nativeFaceTimeMediaUnavailableReason,
      callTopology: this.service.nativeFaceTimeMediaAvailable
        ? "one-to-one"
        : this.#faceTimeMedia
          ? "group"
          : null,
      outboundIdentity: this.service.nativeFaceTimeMediaAvailable
        ? "registered-apple-handle"
        : this.#faceTimeMedia
          ? "apple-web-guest"
          : null,
      modes: this.#faceTimeMedia ? ["audio", "video"] : [],
      outboundMedia: this.#faceTimeMedia
        ? [
          "uploaded-file",
          ...(this.service.nativeFaceTimeLiveAudioAvailable
            && this.#faceTimeMedia.startLiveAudio
            && this.#faceTimeMedia.pushLiveAudioFrame
            && this.#faceTimeMedia.finishLiveAudio
            ? ["live-audio-stream"]
            : []),
        ]
        : [],
      modeCapabilities: {
        audio: {
          available: Boolean(this.#faceTimeMedia),
          verification: this.service.nativeFaceTimeMediaAvailable
            ? "verified-generated-and-phone-originated-aac-eld-playback"
            : this.#faceTimeMedia
              ? "web-fallback"
              : "unavailable",
          transport: this.service.nativeFaceTimeMediaAvailable
            ? "iblue-quickrelay"
            : this.#faceTimeMedia
              ? "apple-web-bridge"
              : null,
          topology: this.service.nativeFaceTimeMediaAvailable
            ? "one-to-one"
            : this.#faceTimeMedia
              ? "group"
              : null,
          outboundIdentity: this.service.nativeFaceTimeMediaAvailable
            ? "registered-apple-handle"
            : this.#faceTimeMedia
              ? "apple-web-guest"
              : null,
          outboundCodec: this.service.nativeFaceTimeMediaAvailable ? "aac-eld-pt104" : null,
        },
        video: {
          available: Boolean(this.#faceTimeMedia),
          verification: this.service.nativeFaceTimeMediaAvailable
            ? "verified-uploaded-playback"
            : this.#faceTimeMedia
              ? "web-fallback"
              : "unavailable",
          productionReady: this.service.nativeFaceTimeMediaAvailable,
          transport: this.service.nativeFaceTimeMediaAvailable
            ? "iblue-quickrelay"
            : this.#faceTimeMedia
              ? "apple-web-bridge"
              : null,
          topology: this.service.nativeFaceTimeMediaAvailable
            ? "one-to-one"
            : this.#faceTimeMedia
              ? "group"
              : null,
          outboundIdentity: this.service.nativeFaceTimeMediaAvailable
            ? "registered-apple-handle"
            : this.#faceTimeMedia
              ? "apple-web-guest"
              : null,
          outboundCodec: this.service.nativeFaceTimeMediaAvailable ? "hevc-pt100" : null,
          streamStateAcknowledgement: this.service.nativeFaceTimeMediaAvailable,
        },
      },
      webFallbackBrowserSandbox: "default",
      inboundMediaStreaming: this.service.nativeFaceTimeStreamingAvailable,
      inboundMediaTransport: this.service.nativeFaceTimeStreamingAvailable ? "socket.io" : null,
      inboundMediaCodecs: this.service.nativeFaceTimeStreamingAvailable
        ? { audio: ["evs", "aac-eld"], video: ["h265"], videoDescription: ["qtff"] }
        : { audio: [], video: [], videoDescription: [] },
      inboundMediaSubscription: this.service.nativeFaceTimeStreamingAvailable
        ? { optIn: true, ttlSeconds: { minimum: 5, maximum: 3_600, default: 300 } }
        : null,
      outboundLiveMediaInjection: Boolean(
        this.service.nativeFaceTimeLiveAudioAvailable
        && this.#faceTimeMedia?.startLiveAudio
        && this.#faceTimeMedia.pushLiveAudioFrame
        && this.#faceTimeMedia.finishLiveAudio,
      ),
      realtimeProtocol: this.service.nativeFaceTimeStreamingAvailable
        || this.service.nativeFaceTimeLiveAudioAvailable
        ? "/api/v1/iblue/facetime/realtime"
        : null,
      realtimeLifecycleEvent: "ft-call-status-changed",
      incomingCalls: {
        available: this.service.nativeFaceTimeIncomingAvailable,
        verification: this.service.nativeFaceTimeIncomingAvailable
          && this.service.nativeFaceTimeMediaAvailable
          ? "verified-audio-and-video-auto-answer-playback"
          : "unavailable",
        list: "/api/v1/iblue/facetime/incoming",
        answer: "/api/v1/iblue/facetime/incoming/{sessionId}/answer",
        answerWithMedia: "/api/v1/iblue/facetime/incoming/{sessionId}/answer-with-media",
        autoAnswer: "/api/v1/iblue/facetime/incoming/auto-answer",
        decline: "/api/v1/iblue/facetime/incoming/{sessionId}/decline",
        topology: "one-to-one",
        outboundIdentity: "registered-apple-handle",
        liveMediaInjection: {
          audio: this.service.nativeFaceTimeLiveAudioAvailable,
          video: this.service.nativeFaceTimeLiveVideoAvailable,
          transport: "socket.io",
        },
      },
      ...(this.#faceTimeMediaUnavailableReason
        ? { unavailableReason: this.#faceTimeMediaUnavailableReason }
        : {}),
    }, "Successfully fetched FaceTime capabilities!"));
    this.app.get("/api/v1/iblue/facetime/realtime", async () => success({
      transport: "socket.io",
      path: "/socket.io",
      authentication: {
        location: "handshake.query",
        parameter: "password",
        aliases: ["guid"],
      },
      controls: {
        list: { requestEvent: "facetime-call-list", responseEvent: "facetime-call-list" },
        get: { requestEvent: "facetime-call-get", responseEvent: "facetime-call-get", required: ["callId"] },
        stop: { requestEvent: "facetime-call-stop", responseEvent: "facetime-call-stop", required: ["callId"] },
        incomingList: { requestEvent: "facetime-incoming-list", responseEvent: "facetime-incoming-list" },
        incomingAnswer: { requestEvent: "facetime-incoming-answer", responseEvent: "facetime-incoming-answer", required: ["sessionId"] },
        incomingDecline: { requestEvent: "facetime-incoming-decline", responseEvent: "facetime-incoming-decline", required: ["sessionId"] },
        incomingLeave: { requestEvent: "facetime-incoming-leave", responseEvent: "facetime-incoming-leave", required: ["sessionId"] },
        incomingLiveAudioStart: { requestEvent: "facetime-live-audio-start", responseEvent: "facetime-live-audio-start", required: ["sessionId"] },
        incomingLiveAudioFrame: { requestEvent: "facetime-live-audio-session-frame", responseEvent: "facetime-live-audio-session-frame", required: ["sessionId", "data"] },
        incomingLiveAudioFinish: { requestEvent: "facetime-live-audio-session-finish", responseEvent: "facetime-live-audio-session-finish", required: ["sessionId"] },
        incomingLiveVideoStart: { requestEvent: "facetime-live-video-start", responseEvent: "facetime-live-video-start", required: ["sessionId", "imageDescription"] },
        incomingLiveVideoFrame: { requestEvent: "facetime-live-video-frame", responseEvent: "facetime-live-video-frame", required: ["sessionId", "data"] },
        incomingLiveVideoFinish: { requestEvent: "facetime-live-video-finish", responseEvent: "facetime-live-video-finish", required: ["sessionId"] },
      },
      inboundMedia: {
        available: this.service.nativeFaceTimeStreamingAvailable,
        subscribeEvent: "facetime-media-subscribe",
        unsubscribeEvent: "facetime-media-unsubscribe",
        frameEvent: "ft-media-frame",
        codecs: { audio: ["evs", "aac-eld"], video: ["h265"], videoDescription: ["qtff"] },
        request: {
          oneOf: ["callId for an iBlue-created call", "sessionId for an iBlue-answered incoming call"],
          optional: { audio: "boolean (default true)", video: "boolean (default false)", ttlSeconds: "integer 5..3600 (default 300)" },
        },
        frame: {
          fields: [
            "subscriptionId", "callId (outgoing/managed calls only)", "sessionId", "kind", "codec", "payloadType", "rtpTimestamp",
            "durationMs", "droppedPackets", "receivedAt", "data",
          ],
          data: "Socket.IO binary Buffer containing one encoded codec access unit or Annex-B H.265 sample",
        },
        persistence: "none",
        webhookDelivery: false,
        explicitOptIn: true,
      },
      outboundLiveMediaInjection: {
        available: Boolean(
          this.service.nativeFaceTimeLiveAudioAvailable
          && this.#faceTimeMedia?.startLiveAudio
          && this.#faceTimeMedia.pushLiveAudioFrame
          && this.#faceTimeMedia.finishLiveAudio,
        ),
        verification: "verified-native-aac-eld-pt104-playback",
        createEvent: "facetime-live-audio-create",
        frameEvent: "facetime-live-audio-frame",
        finishEvent: "facetime-live-audio-finish",
        lifecycleEvent: "ft-call-status-changed",
        createRequest: {
          required: ["target or address"],
          optional: {
            displayName: "string (default iBlue)",
            from: "registered iBlue handle",
            maxDurationSeconds: "integer 15..600 (default 300)",
          },
        },
        frameRequest: {
          required: ["callId", "data"],
          data: "Socket.IO binary Buffer: exactly 1920 bytes of 24 kHz mono float32 little-endian PCM (20 ms)",
          acknowledgement: "one acknowledgement per accepted or rejected frame",
        },
        ownership: "Only the authenticated socket that creates a call may inject or finish its stream",
        disconnectBehavior: "The call is finished immediately when its owner socket disconnects",
        concurrency: "One active deterministic FaceTime media call per server process",
        queueCapacityFrames: 50,
        safetyDeadlineSeconds: { minimum: 15, maximum: 600, default: 300 },
        persistence: "none",
        webhookDelivery: false,
      },
      incomingLiveMediaInjection: {
        available: this.service.nativeFaceTimeLiveAudioAvailable,
        audio: {
          available: this.service.nativeFaceTimeLiveAudioAvailable,
          startEvent: "facetime-live-audio-start",
          frameEvent: "facetime-live-audio-session-frame",
          finishEvent: "facetime-live-audio-session-finish",
          format: "24 kHz mono float32 little-endian PCM; exactly 1920 bytes per 20 ms frame",
          queueCapacityFrames: 50,
        },
        video: {
          available: this.service.nativeFaceTimeLiveVideoAvailable,
          startEvent: "facetime-live-video-start",
          frameEvent: "facetime-live-video-frame",
          finishEvent: "facetime-live-video-finish",
          format: "one Annex-B H.265 access unit per binary Socket.IO frame",
          imageDescription: "one complete hvc1 sample entry containing hvcC",
          frameDurationMs: { minimum: 20, maximum: 100, default: 40 },
          queueCapacityFrames: 8,
          maxFrameBytes: 4 * 1024 * 1024,
        },
        ownership: "One authenticated socket owns live injection for each answered incoming call",
        disconnectBehavior: "Injected streams and the incoming call end when the owner socket disconnects",
      },
    }, "Successfully fetched FaceTime realtime protocol metadata!"));
    this.app.get("/api/v1/iblue/facetime/call", async () =>
      success(this.#faceTimeMedia?.list() ?? [], "Successfully fetched FaceTime media calls!"));
    this.app.get<{ Params: { callId: string } }>(
      "/api/v1/iblue/facetime/call/:callId",
      async (request, reply) => {
        const call = this.#faceTimeMedia?.get(request.params.callId);
        if (!call) return reply.code(404).send(notFound("FaceTime media call not found!"));
        return success(call, "Successfully fetched FaceTime media call!");
      },
    );
    this.app.post("/api/v1/iblue/facetime/call", async (request) => {
      if (!this.#faceTimeMedia) {
        throw new RequestError(
          500,
          this.#faceTimeMediaUnavailableReason ?? "FaceTime media is unavailable",
          "FACETIME_MEDIA_UNAVAILABLE",
        );
      }
      const file = await request.file();
      if (!file || file.fieldname !== "media") {
        throw new RequestError(400, "FaceTime media file is required", "VALIDATION_ERROR");
      }
      const directory = await mkdtemp(join(tmpdir(), "iblue-facetime-upload-"));
      const filename = safeAttachmentName(file.filename || "media");
      const path = join(directory, filename);
      try {
        const size = await saveMultipartFile(file, path);
        if (size === 0 || size > 95 * 1024 * 1024) {
          throw new RequestError(
            400,
            "FaceTime media must be between 1 byte and 95 MiB",
            "VALIDATION_ERROR",
          );
        }
        const address = multipartField(file, "address");
        const targetsField = multipartField(file, "targets");
        let targets: string[] = [];
        if (targetsField) {
          try {
            const parsed: unknown = JSON.parse(targetsField);
            if (Array.isArray(parsed)) {
              targets = parsed.filter((value): value is string => typeof value === "string");
            }
          } catch {
            targets = targetsField.split(",").map((value) => value.trim()).filter(Boolean);
          }
        } else if (address) {
          targets = [address];
        }
        if (targets.length === 0) {
          throw new RequestError(400, "address or targets is required", "VALIDATION_ERROR");
        }
        targets = targets.map((target) =>
          target.startsWith("tel:") || target.startsWith("mailto:")
            ? target
            : toTransportAddress(target));
        const requestedMode = multipartField(file, "mode");
        const mode: FaceTimeMediaMode = requestedMode === "video"
          ? "video"
          : requestedMode === "audio"
            ? "audio"
            : file.mimetype.startsWith("video/")
              ? "video"
              : "audio";
        if (!file.mimetype.startsWith(`${mode}/`)) {
          throw new RequestError(
            400,
            `The ${mode} call requires an ${mode} media upload`,
            "VALIDATION_ERROR",
          );
        }
        const rawDuration = multipartField(file, "maxDurationSeconds");
        const maxDurationSeconds = rawDuration === undefined ? undefined : Number(rawDuration);
        if (maxDurationSeconds !== undefined && (
          !Number.isSafeInteger(maxDurationSeconds)
          || maxDurationSeconds < 15
          || maxDurationSeconds > 600
        )) {
          throw new RequestError(
            400,
            "maxDurationSeconds must be an integer between 15 and 600",
            "VALIDATION_ERROR",
          );
        }
        const nativeAudioPassthrough = multipartField(file, "nativeAudioPassthrough") === "true";
        if (nativeAudioPassthrough && mode !== "audio") {
          throw new RequestError(
            400,
            "nativeAudioPassthrough is available only for audio calls",
            "VALIDATION_ERROR",
          );
        }
        const nativeVideoPassthrough = multipartField(file, "nativeVideoPassthrough") === "true";
        if (nativeVideoPassthrough && mode !== "video") {
          throw new RequestError(
            400,
            "nativeVideoPassthrough is available only for video calls",
            "VALIDATION_ERROR",
          );
        }
        const call = await this.#faceTimeMedia.start({
          mode,
          targets,
          displayName: multipartField(file, "displayName") ?? "iBlue",
          sourcePath: path,
          ...(multipartField(file, "from") ? { from: multipartField(file, "from")! } : {}),
          ...(maxDurationSeconds === undefined ? {} : { maxDurationSeconds }),
          ...(nativeAudioPassthrough ? { nativeAudioPassthrough: true } : {}),
          ...(nativeVideoPassthrough ? { nativeVideoPassthrough: true } : {}),
        });
        return success(call, "FaceTime media call is starting!");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    this.app.delete<{ Params: { callId: string } }>(
      "/api/v1/iblue/facetime/call/:callId",
      async (request, reply) => {
        const call = await this.#faceTimeMedia?.stop(request.params.callId);
        if (!call) return reply.code(404).send(notFound("FaceTime media call not found!"));
        return success(call, "FaceTime media call ended!");
      },
    );

    // Contacts.app belongs to the signed-in macOS user and is intentionally
    // outside the isolated iBlue profile. Keep the stock BlueBubbles contact
    // surface neutral; normalized profile-local contacts are exposed under
    // /api/v1/iblue/contact without changing BlueBubbles' response schema.
    this.app.get("/api/v1/contact", async () => success([]));
    this.app.post("/api/v1/contact/query", async () => success([]));

    this.app.get<{ Querystring: Query }>("/api/v1/iblue/contact", async (request) => {
      const result = this.service.store.queryContacts({
        ...(request.query.address ? { addresses: [request.query.address] } : {}),
        ...(request.query.search ? { search: request.query.search } : {}),
        offset: numberValue(request.query.offset, 0),
        limit: numberValue(request.query.limit, 100),
      });
      return success(result.contacts, "Successfully fetched iBlue contacts!", {
        total: result.total,
        offset: numberValue(request.query.offset, 0),
        limit: numberValue(request.query.limit, 100),
        count: result.contacts.length,
      });
    });
    this.app.post("/api/v1/iblue/contact/query", async (request) => {
      const body = asRecord(request.body);
      const addresses = Array.isArray(body.addresses)
        ? body.addresses.filter((value): value is string => typeof value === "string")
        : undefined;
      const sources = Array.isArray(body.sources)
        ? body.sources.filter((value): value is "profile-vcf" | "icloud-carddav" | "name-and-photo-sharing" =>
          value === "profile-vcf" || value === "icloud-carddav" || value === "name-and-photo-sharing")
        : undefined;
      const offset = numberValue(body.offset, 0);
      const limit = numberValue(body.limit, 100);
      const result = this.service.store.queryContacts({
        ...(addresses ? { addresses } : {}),
        ...(typeof body.search === "string" ? { search: body.search } : {}),
        ...(sources ? { sources } : {}),
        offset,
        limit,
      });
      return success(result.contacts, "Successfully queried iBlue contacts!", {
        total: result.total,
        offset,
        limit,
        count: result.contacts.length,
      });
    });
    this.app.post("/api/v1/iblue/contact/icloud/sync", async () =>
      success(await this.service.syncICloudContacts(), "Successfully synced iCloud Contacts!"));

    this.app.post("/api/v1/iblue/focus/sync", async (request) => {
      const body = asRecord(request.body);
      const cachedZone = typeof body.cachedZone === "string" && body.cachedZone.trim()
        ? body.cachedZone.trim()
        : undefined;
      const continuationToken = typeof body.continuationToken === "string" && body.continuationToken.trim()
        ? body.continuationToken.trim()
        : undefined;
      return success(
        await this.service.syncFocusPeers(cachedZone, continuationToken),
        "Successfully synced Focus sharing keys!",
      );
    });
    this.app.post("/api/v1/iblue/focus/subscribe", async (request) => {
      const body = asRecord(request.body);
      const handles = Array.isArray(body.handles)
        ? body.handles.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      if (handles.length === 0 || handles.length > 256) {
        throw new RequestError(400, "handles must contain between 1 and 256 addresses", "VALIDATION_ERROR");
      }
      return success(await this.service.subscribeFocus(handles), "Successfully subscribed to Focus status!");
    });
    this.app.post("/api/v1/iblue/focus/share", async (request) => {
      const body = asRecord(request.body);
      if (typeof body.active !== "boolean") {
        throw new RequestError(400, "active must be a boolean", "VALIDATION_ERROR");
      }
      const mode = typeof body.mode === "string" && body.mode.trim() ? body.mode.trim() : undefined;
      return success(await this.service.shareFocus(body.active, mode), "Successfully shared Focus status!");
    });
    this.app.get("/api/v1/iblue/contact/vcf", async () =>
      success(await this.loadContactsVcf(), "Successfully retrieved profile VCF"));
    this.app.put("/api/v1/iblue/contact/vcf", async (request) => {
      const body = asRecord(request.body);
      const vcf = requiredString(body, "vcf");
      const imported = await this.saveContactsVcf(vcf);
      return success({ imported }, "Successfully imported profile VCF");
    });
    this.app.get<{ Params: { address: string } }>(
      "/api/v1/iblue/contact/:address/avatar",
      async (request, reply) => {
        const avatar = this.service.store.getContactAvatar(request.params.address);
        if (!avatar) return reply.code(404).send(notFound("Contact avatar not found!"));
        reply.header("content-type", detectImageMime(avatar.data));
        reply.header("cache-control", "private, max-age=3600");
        return reply.send(avatar.data);
      },
    );
    this.app.post("/api/v1/iblue/contact-card", async (request) => {
      const body = asRecord(request.body);
      const chatGuid = requiredString(body, "chatGuid");
      const contact = contactCardInput(body);
      const stagedPhoto = typeof body.photo === "string" && body.photo.length > 0 ? body.photo : undefined;
      const photoAttachmentGuid = typeof body.photoAttachmentGuid === "string" && body.photoAttachmentGuid.length > 0
        ? body.photoAttachmentGuid
        : undefined;
      if (stagedPhoto && photoAttachmentGuid) {
        throw new RequestError(400, "Use either photo or photoAttachmentGuid, not both", "VALIDATION_ERROR");
      }

      let photo: { data: Buffer; mimeType: string } | undefined;
      let stagedDirectory: string | undefined;
      if (stagedPhoto) {
        const staged = this.resolveMultipartUpload(stagedPhoto);
        const info = await stat(staged.path).catch(() => undefined);
        if (!info?.isFile() || info.size === 0) {
          throw new RequestError(400, `Attachment '${stagedPhoto}' does not exist`, "VALIDATION_ERROR");
        }
        stagedDirectory = staged.directory;
        const data = await readFile(staged.path);
        photo = { data, mimeType: contactPhotoMime(data) };
      } else if (photoAttachmentGuid) {
        const stored = this.service.store.getAttachment(photoAttachmentGuid);
        if (!stored?.path) throw new RequestError(404, "Contact photo attachment not found!", "NOT_FOUND");
        const data = await readFile(stored.path);
        photo = { data, mimeType: contactPhotoMime(data) };
      }

      const directory = await mkdtemp(join(tmpdir(), "iblue-contact-card-"));
      const filename = safeAttachmentName(`${contact.displayName.replace(/[^\p{L}\p{N} ._-]/gu, "").trim() || "Contact"}.vcf`);
      const path = join(directory, filename);
      try {
        await writeFile(path, buildVCardContact(contact, photo), { mode: 0o600 });
        const message = await this.service.sendAttachment({
          chatGuid,
          path,
          filename,
          mimeType: "text/vcard",
          utiType: "public.vcard",
        });
        return success(message, "Contact card sent!");
      } finally {
        await rm(directory, { recursive: true, force: true });
        if (stagedDirectory) await rm(stagedDirectory, { recursive: true, force: true });
      }
    });
    this.app.get<{ Params: { attachmentGuid: string }; Querystring: Query }>(
      "/api/v1/iblue/contact-card/:attachmentGuid/photo",
      async (request, reply) => {
        const attachment = this.service.store.getAttachment(request.params.attachmentGuid);
        if (!attachment?.path || (attachment.response.mimeType !== "text/vcard"
          && attachment.response.uti !== "public.vcard")) {
          return reply.code(404).send(notFound("Contact card not found!"));
        }
        const cardIndex = Math.max(0, Math.trunc(numberValue(request.query.cardIndex, 0)));
        const card = parseVCardContactCards(await readFile(attachment.path, "utf8"))[cardIndex];
        if (!card?.photoData || !card.photo) {
          return reply.code(404).send(notFound("Contact card photo not found!"));
        }
        reply.header("content-type", card.photo.mimeType);
        reply.header("content-disposition", `inline; filename="contact-${cardIndex}.${card.photo.mimeType === "image/png" ? "png" : "jpg"}"`);
        reply.header("cache-control", "private, max-age=3600");
        return reply.send(card.photoData);
      },
    );

    this.app.get("/api/v1/iblue/message/flair", async () =>
      success(MESSAGE_FLAIRS.map((flair) => ({ ...flair })), "Successfully fetched message flair catalog!", {
        count: MESSAGE_FLAIRS.length,
      }));
    this.app.get("/api/v1/iblue/message/text-effects", async () =>
      success({
        styles: [...IBLUE_TEXT_STYLES],
        effects: [...IBLUE_TEXT_EFFECTS],
        rangeEncoding: "utf-16",
      }, "Successfully fetched attributed text capabilities!"));

    this.app.post("/api/v1/iblue/rich-link", async (request) => {
      const body = asRecord(request.body);
      const originalUrl = requiredString(body, "originalUrl");
      let artwork: { attachmentGuid: string; path: string; mimeType: string } | undefined;
      if (typeof body.artworkAttachmentGuid === "string") {
        const stored = this.service.store.getAttachment(body.artworkAttachmentGuid);
        if (!stored?.path) throw new RequestError(404, "Artwork attachment not found!", "NOT_FOUND");
        artwork = {
          attachmentGuid: body.artworkAttachmentGuid,
          path: stored.path,
          mimeType: stored.response.mimeType,
        };
      }
      const appleMusic = asRecord(body.appleMusic);
      const appleMusicPlayback = Object.keys(appleMusic).length > 0
        ? {
          storefrontIdentifier: requiredString(appleMusic, "storefrontIdentifier"),
          storeIdentifier: requiredString(appleMusic, "storeIdentifier"),
          name: requiredString(appleMusic, "name"),
          artist: requiredString(appleMusic, "artist"),
          album: requiredString(appleMusic, "album"),
          previewUrl: requiredString(appleMusic, "previewUrl"),
        }
        : undefined;
      const message = await this.service.sendRichLink({
        chatGuid: requiredString(body, "chatGuid"),
        originalUrl,
        ...(typeof body.url === "string" ? { url: body.url } : {}),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
        ...(artwork ? { artwork } : {}),
        ...(appleMusicPlayback ? { appleMusicPlayback } : {}),
      });
      return success(message, "Rich link sent!");
    });

    this.app.post("/api/v1/iblue/message/component", async (request) => {
      const body = asRecord(request.body);
      const bundleId = requiredString(body, "bundleId");
      const url = requiredString(body, "url");
      if (bundleId.length > 512 || url.length > 16 * 1024) {
        throw new RequestError(400, "component bundleId or url is too long", "VALIDATION_ERROR");
      }
      let iconPath: string | undefined;
      if (typeof body.iconAttachmentGuid === "string") {
        const attachment = this.service.store.getAttachment(body.iconAttachmentGuid);
        if (!attachment?.path) throw new RequestError(404, "Component icon attachment not found!", "NOT_FOUND");
        iconPath = attachment.path;
      }
      const optional = (key: string): string | undefined =>
        typeof body[key] === "string" ? body[key] as string : undefined;
      const appId = typeof body.appId === "number" && Number.isSafeInteger(body.appId)
        ? body.appId
        : undefined;
      const sessionId = optional("sessionId");
      const ldText = optional("ldText");
      const imageTitle = optional("imageTitle");
      const imageSubtitle = optional("imageSubtitle");
      const caption = optional("caption");
      const subcaption = optional("subcaption");
      const secondarySubcaption = optional("secondarySubcaption");
      const tertiarySubcaption = optional("tertiarySubcaption");
      // Messages extension bubbles use the object-replacement character when
      // the caller does not provide a visible fallback body.
      const text = optional("text") ?? "\ufffc";
      const subject = optional("subject");
      const replyGuid = optional("replyGuid");
      const replyPart = optional("replyPart");
      const message = await this.service.sendComponent({
        chatGuid: requiredString(body, "chatGuid"),
        bundleId,
        appName: optional("appName") ?? "iBlue",
        url,
        ...(appId === undefined ? {} : { appId }),
        ...(sessionId ? { sessionId } : {}),
        isLive: body.isLive === true,
        ...(ldText ? { ldText } : {}),
        ...(imageTitle ? { imageTitle } : {}),
        ...(imageSubtitle ? { imageSubtitle } : {}),
        ...(caption ? { caption } : {}),
        ...(subcaption ? { subcaption } : {}),
        ...(secondarySubcaption ? { secondarySubcaption } : {}),
        ...(tertiarySubcaption ? { tertiarySubcaption } : {}),
        ...(iconPath ? { iconPath } : {}),
        text,
        ...(subject ? { subject } : {}),
        ...(replyGuid ? { replyGuid } : {}),
        ...(replyPart ? { replyPart } : {}),
      });
      return success(message, "iMessage component sent!");
    });

    for (const kind of ["chats", "messages", "attachments"] as const) {
      this.app.post(`/api/v1/iblue/cloud/messages/${kind}/sync`, async (request) => {
        const body = asRecord(request.body);
        const token = typeof body.continuationToken === "string" ? body.continuationToken : undefined;
        const page = kind === "chats"
          ? await this.service.syncCloudChats(token)
          : kind === "messages"
            ? await this.service.syncCloudMessages(token)
            : await this.service.syncCloudAttachments(token);
        return success(page, `Successfully synced Messages in iCloud ${kind} page!`);
      });
    }

    this.app.get<{ Params: { guid: string } }>("/api/v1/iblue/chat/:guid/background", async (request, reply) => {
      const background = this.service.store.getConversationBackground(request.params.guid);
      if (!background) return reply.code(404).send(notFound("Conversation background not found!"));
      return success(background, "Successfully fetched conversation background!");
    });
    this.app.get("/api/v1/iblue/background/presets", async () =>
      success(
        IBLUE_BUILTIN_CONVERSATION_BACKGROUNDS,
        "Successfully fetched built-in conversation backgrounds!",
      ));
    this.app.post<{ Params: { guid: string } }>("/api/v1/iblue/chat/:guid/background", async (request) => {
      const body = asRecord(request.body);
      const remove = body.remove === true;
      const preset = body.preset === undefined ? undefined : requiredString(body, "preset");
      const colors = body.colors === undefined
        ? undefined
        : normalizeConversationBackgroundColors(body.colors);
      if (body.colors !== undefined && !colors) {
        throw new RequestError(
          400,
          "colors must contain exactly two #RRGGBB or #RRGGBBAA values",
          "VALIDATION_ERROR",
        );
      }
      const hasAttachment = typeof body.attachment === "string";
      const hasAttachmentGuid = typeof body.attachmentGuid === "string";
      if (remove && (preset || hasAttachment || hasAttachmentGuid)) {
        throw new RequestError(
          400,
          "remove cannot be combined with a background image or preset",
          "VALIDATION_ERROR",
        );
      }
      if (preset && (hasAttachment || hasAttachmentGuid)) {
        throw new RequestError(
          400,
          "A conversation background cannot be both a photo and a built-in preset",
          "VALIDATION_ERROR",
        );
      }
      if (preset && !isBuiltinConversationBackgroundPreset(preset)) {
        throw new RequestError(400, `Unknown built-in conversation background preset: ${preset}`, "VALIDATION_ERROR");
      }
      if (preset === "color" && !colors) {
        throw new RequestError(400, "The Color background requires colors", "VALIDATION_ERROR");
      }
      if (preset !== "color" && colors) {
        throw new RequestError(400, "colors can only be used with the Color background", "VALIDATION_ERROR");
      }
      let path: string | undefined;
      let stagedDirectory: string | undefined;
      if (!remove && !preset) {
        if (typeof body.attachment === "string") {
          const staged = this.resolveMultipartUpload(body.attachment);
          const info = await stat(staged.path).catch(() => undefined);
          if (!info?.isFile() || info.size === 0) {
            throw new RequestError(404, "Staged background attachment not found!", "NOT_FOUND");
          }
          if (!mimeForFilename(basename(staged.path)).startsWith("image/")) {
            throw new RequestError(400, "Conversation backgrounds require an image attachment", "VALIDATION_ERROR");
          }
          path = staged.path;
          stagedDirectory = staged.directory;
        } else {
          const attachmentGuid = requiredString(body, "attachmentGuid");
          const attachment = this.service.store.getAttachment(attachmentGuid);
          if (!attachment?.path) throw new RequestError(404, "Background attachment not found!", "NOT_FOUND");
          if (!attachment.response.mimeType.startsWith("image/")) {
            throw new RequestError(400, "Conversation backgrounds require an image attachment", "VALIDATION_ERROR");
          }
          path = attachment.path;
        }
      }
      try {
        return success(
          await this.service.setConversationBackground({
            chatGuid: request.params.guid,
            ...(path ? { path } : {}),
            ...(preset ? { preset } : {}),
            ...(colors ? { colors } : {}),
          }),
          remove ? "Conversation background removed!" : "Conversation background changed!",
        );
      } finally {
        if (stagedDirectory) await rm(stagedDirectory, { recursive: true, force: true });
      }
    });

    this.app.get<{ Params: { messageGuid: string } }>(
      "/api/v1/iblue/icloud-share/:messageGuid",
      async (request) => {
        const message = this.service.store.getMessage(request.params.messageGuid);
        const share = message?.iBlue?.icloudShare;
        if (!share) throw new RequestError(404, "iCloud Photos share not found!", "NOT_FOUND");
        try {
          const resolved = await this.icloudShareResolver.resolve(share.url);
          return success(
            publicICloudShare(resolved, request.params.messageGuid),
            "Successfully resolved iCloud Photos share!",
          );
        } catch (error) {
          throw iCloudShareRequestError(error);
        }
      },
    );

    this.app.get<{
      Params: { messageGuid: string; itemGuid: string; variant: string };
    }>(
      "/api/v1/iblue/icloud-share/:messageGuid/item/:itemGuid/:variant",
      async (request, reply) => {
        const message = this.service.store.getMessage(request.params.messageGuid);
        const share = message?.iBlue?.icloudShare;
        if (!share) throw new RequestError(404, "iCloud Photos share not found!", "NOT_FOUND");
        const variant = iCloudShareVariant(request.params.variant);
        if (!variant) {
          throw new RequestError(400, "variant must be original, medium, or thumbnail", "VALIDATION_ERROR");
        }
        try {
          const asset = await this.icloudShareResolver.fetchAsset(share.url, request.params.itemGuid, variant);
          if (!asset.response.body) throw new ICloudShareError("Apple returned empty shared media");
          reply.header("content-type", asset.mimeType);
          reply.header("content-length", String(asset.totalBytes));
          reply.header("content-disposition", `inline; filename="${asset.filename}"`);
          reply.header("cache-control", "private, max-age=300");
          return reply.send(Readable.fromWeb(
            asset.response.body as unknown as import("node:stream/web").ReadableStream,
          ));
        } catch (error) {
          throw iCloudShareRequestError(error);
        }
      },
    );

    this.app.post("/api/v1/iblue/icloud-share", async (request) => {
      const body = asRecord(request.body);
      const url = requiredString(body, "url");
      let resolved;
      try {
        resolved = await this.icloudShareResolver.resolve(url);
      } catch (error) {
        throw iCloudShareRequestError(error);
      }
      const presentation = iCloudSharePresentation(resolved);
      const message = await this.service.sendICloudShare({
        chatGuid: requiredString(body, "chatGuid"),
        url: resolved.url,
        caption: typeof body.caption === "string" ? body.caption : presentation.caption,
        subcaption: typeof body.subcaption === "string" ? body.subcaption : presentation.subcaption,
        ldText: typeof body.ldText === "string" ? body.ldText : presentation.ldText,
      });
      return success(message, "iCloud Photos share sent!");
    });

    this.app.post("/api/v1/iblue/icloud-share/create", async (request) => {
      const file = await request.file();
      if (!file || !["photo", "media"].includes(file.fieldname)) {
        throw new RequestError(400, "Photos media not provided or was empty!", "VALIDATION_ERROR");
      }
      const filename = safeAttachmentName(file.filename || "photo.jpg");
      const mimeType = file.mimetype || mimeForFilename(filename);
      if (!["image/jpeg", "image/png", "image/heic", "image/heif", "video/quicktime", "video/mp4"].includes(mimeType)) {
        throw new RequestError(
          mimeType === "image/gif" ? 415 : 400,
          mimeType === "image/gif"
            ? "Apple's iCloud Photos web importer does not accept GIF; send it through the ordinary iMessage attachment API"
            : "Fresh iCloud Photos shares require JPEG, PNG, HEIC/HEIF, MOV, or MP4 media",
          "VALIDATION_ERROR",
        );
      }
      const directory = await mkdtemp(join(tmpdir(), "iblue-icloud-photo-share-"));
      const path = join(directory, filename);
      try {
        if (await saveMultipartFile(file, path) === 0) {
          throw new RequestError(400, "Photos media not provided or was empty!", "VALIDATION_ERROR");
        }
        // Fields following the file become available only after its stream is
        // consumed. Accept either multipart order, as the attachment API does.
        const chatGuid = multipartField(file, "chatGuid");
        if (!chatGuid) throw new RequestError(400, "chatGuid is required", "VALIDATION_ERROR");
        const created = await this.service.createICloudPhotoShare({
          chatGuid,
          path,
          filename,
          mimeType,
          ...(multipartField(file, "title") === undefined
            ? {}
            : { title: multipartField(file, "title")! }),
        });
        // A newly written CloudKit share can resolve before its anonymous
        // public-access grant has propagated. Wait for that grant so the API
        // never sends a bearer URL that the recipient cannot open yet.
        const resolved = await resolveFreshICloudShare(this.icloudShareResolver, created.url);
        const presentation = iCloudSharePresentation(resolved);
        const message = await this.service.sendICloudShare({
          chatGuid,
          url: created.url,
          caption: multipartField(file, "caption") ?? presentation.caption,
          subcaption: multipartField(file, "subcaption") ?? presentation.subcaption,
          ldText: multipartField(file, "ldText") ?? presentation.ldText,
        });
        return success({
          message,
          share: {
            provider: "icloud-photos",
            ...created,
          },
        }, "Fresh iCloud Photos share created and sent!");
      } catch (error) {
        throw iCloudShareRequestError(error);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    this.app.get<{ Params: { messageGuid: string } }>(
      "/api/v1/iblue/poll/:messageGuid",
      async (request, reply) => {
        const poll = this.service.store.getPoll(request.params.messageGuid);
        if (!poll) return reply.code(404).send(notFound("Poll not found!"));
        return success(poll, "Successfully fetched poll!");
      },
    );
    this.app.post("/api/v1/iblue/poll", async (request) => {
      const body = asRecord(request.body);
      if (!Array.isArray(body.options)
        || body.options.length < 2
        || body.options.length > 32
        || body.options.some((value) => typeof value !== "string" || !value.trim())) {
        throw new RequestError(
          400,
          "options must contain between 2 and 32 non-empty poll option strings",
          "VALIDATION_ERROR",
        );
      }
      const message = await this.service.sendPoll({
        chatGuid: requiredString(body, "chatGuid"),
        options: body.options.map((value) => (value as string).trim()),
        ...(typeof body.title === "string" ? { title: body.title.trim() } : {}),
      });
      return success(message, "Poll sent!");
    });
    this.app.post<{ Params: { messageGuid: string } }>(
      "/api/v1/iblue/poll/:messageGuid/vote",
      async (request) => {
        const body = asRecord(request.body);
        if (!Array.isArray(body.optionIdentifiers)
          || body.optionIdentifiers.some((value) => typeof value !== "string")) {
          throw new RequestError(
            400,
            "optionIdentifiers must be an array of poll option identifier strings",
            "VALIDATION_ERROR",
          );
        }
        const result = await this.service.sendPollVote({
          messageGuid: request.params.messageGuid,
          optionIdentifiers: body.optionIdentifiers,
        });
        return success(result, "Poll vote sent!");
      },
    );

    this.app.post("/api/v1/iblue/location/query", async (request) => {
      const body = asRecord(request.body);
      const offset = numberValue(body.offset, 0);
      const limit = numberValue(body.limit, 100);
      const result = this.service.store.querySharedLocations({
        ...(typeof body.chatGuid === "string" ? { chatGuid: body.chatGuid } : {}),
        ...(body.after === undefined ? {} : { after: numberValue(body.after, 0) }),
        ...(body.before === undefined ? {} : { before: numberValue(body.before, Date.now()) }),
        offset,
        limit,
      });
      return success(result.locations, "Successfully queried shared locations!", {
        total: result.total,
        offset,
        limit,
        count: result.locations.length,
      });
    });
    this.app.get<{ Querystring: Query }>("/api/v1/iblue/location/live", async (request) => {
      const locations = await this.service.refreshLiveLocations(request.query.address);
      return success(locations, "Successfully refreshed live shared locations!", {
        count: locations.length,
        refreshedAt: Date.now(),
        ...(request.query.address ? { address: stripTransport(request.query.address) } : {}),
      });
    });
    this.app.get<{ Params: { messageGuid: string } }>(
      "/api/v1/iblue/location/:messageGuid",
      async (request, reply) => {
        const location = this.service.store.getSharedLocation(request.params.messageGuid);
        if (!location) return reply.code(404).send(notFound("Shared location not found!"));
        return success(location);
      },
    );

    // BlueBubbles' manual setup treats this exact missing-config error as a
    // successful connection without Firebase. Socket.IO and webhooks are
    // iBlue's realtime transports; POST /fcm/device remains a structured 501.
    this.app.get("/api/v1/fcm/client", async (_request, reply) =>
      reply.code(404).send(notFound("Google Services file not found.")),
    );

    this.app.post("/api/v1/chat/query", async (request) => {
      const body = asRecord(request.body);
      const offset = numberValue(body.offset, 0);
      const limit = numberValue(body.limit, 1000);
      const withValues = Array.isArray(body.with) ? body.with.map(String) : [];
      const result = this.service.store.queryChats({
        offset,
        limit,
        withLastMessage: withValues.some((value) => ["lastmessage", "last-message"].includes(value.toLowerCase())),
      });
      return success(result.chats, "Successfully fetched chats!", {
        count: result.chats.length,
        total: result.total,
        offset,
        limit,
      });
    });

    this.app.put<{ Params: { guid: string } }>("/api/v1/chat/:guid", async (request, reply) => {
      const existing = this.service.store.getChat(request.params.guid, true, true);
      if (!existing) return reply.code(404).send(notFound("Chat does not exist!"));
      const body = asRecord(request.body);
      if (typeof body.displayName !== "string" || body.displayName.length === 0) {
        return success(existing, "Chat not updated! No update information provided!");
      }
      const chat = await this.service.renameGroup(request.params.guid, body.displayName);
      return success(chat, "Successfully updated the following fields: displayName");
    });

    const changeParticipant = (action: "add" | "remove") => async (
      request: { params: { guid: string }; body: unknown },
      reply: FastifyReply,
    ) => {
      if (!this.service.store.getChat(request.params.guid)) {
        return reply.code(404).send(notFound("Chat does not exist!"));
      }
      const body = asRecord(request.body);
      const address = requiredString(body, "address");
      return success(await this.service.changeGroupParticipant(request.params.guid, address, action));
    };
    this.app.post<{ Params: { guid: string } }>("/api/v1/chat/:guid/participant", changeParticipant("add"));
    this.app.delete<{ Params: { guid: string } }>("/api/v1/chat/:guid/participant", changeParticipant("remove"));
    this.app.post<{ Params: { guid: string } }>("/api/v1/chat/:guid/participant/add", changeParticipant("add"));
    this.app.post<{ Params: { guid: string } }>("/api/v1/chat/:guid/participant/remove", changeParticipant("remove"));

    this.app.get<{ Params: { guid: string } }>("/api/v1/chat/:guid/icon", async (request, reply) => {
      if (!this.service.store.getChat(request.params.guid)) {
        return reply.code(404).send(notFound("Chat does not exist!"));
      }
      const icon = this.service.store.getGroupIcon(request.params.guid);
      if (!icon) return reply.code(404).send(notFound("Unable to find icon for the selected chat"));
      reply.header("content-type", icon.mimeType);
      return reply.send(await readFile(icon.path));
    });
    this.app.post<{ Params: { guid: string } }>("/api/v1/chat/:guid/icon", async (request, reply) => {
      if (!this.service.store.getChat(request.params.guid)) {
        return reply.code(404).send(notFound("Chat does not exist!"));
      }
      const file = await request.file();
      if (!file || file.fieldname !== "icon") {
        throw new RequestError(400, "Icon not provided or was empty!", "VALIDATION_ERROR");
      }
      const directory = await mkdtemp(join(tmpdir(), "iblue-group-icon-"));
      const path = join(directory, safeAttachmentName(file.filename));
      try {
        if (await saveMultipartFile(file, path) === 0) {
          throw new RequestError(400, "Icon not provided or was empty!", "VALIDATION_ERROR");
        }
        await this.service.setGroupIcon(request.params.guid, {
          path,
          mimeType: file.mimetype || "image/jpeg",
        });
        return success(undefined, "Successfully set group chat icon!");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    this.app.delete<{ Params: { guid: string } }>("/api/v1/chat/:guid/icon", async (request, reply) => {
      if (!this.service.store.getChat(request.params.guid)) {
        return reply.code(404).send(notFound("Chat does not exist!"));
      }
      await this.service.setGroupIcon(request.params.guid);
      return success(undefined, "Successfully removed group chat icon!");
    });

    this.app.get<{ Params: { guid: string }; Querystring: Query }>("/api/v1/chat/:guid", async (request, reply) => {
      const withValues = (request.query.with ?? "").split(",").map((value) => value.toLowerCase());
      const chat = this.service.store.getChat(
        request.params.guid,
        withValues.includes("participants"),
        withValues.includes("lastmessage"),
      );
      if (!chat) return reply.code(404).send(notFound("Chat does not exist!"));
      return success(chat);
    });

    this.app.post<{ Params: { guid: string } }>("/api/v1/chat/:guid/read", async (request, reply) => {
      if (!this.service.store.getChat(request.params.guid)) {
        return reply.code(404).send(notFound("Chat does not exist!"));
      }
      const body = asRecord(request.body);
      await this.service.markChatRead(
        request.params.guid,
        typeof body.messageGuid === "string" ? body.messageGuid : undefined,
      );
      return success(undefined, "Successfully marked chat as read!");
    });
    this.app.post<{ Params: { guid: string } }>("/api/v1/chat/:guid/unread", async (request, reply) => {
      if (!this.service.store.getChat(request.params.guid)) {
        return reply.code(404).send(notFound("Chat does not exist!"));
      }
      await this.service.markChatUnread(request.params.guid);
      return success(undefined, "Successfully marked chat as unread!");
    });
    this.app.post<{ Params: { guid: string } }>("/api/v1/chat/:guid/leave", async (request, reply) => {
      if (!this.service.store.getChat(request.params.guid)) {
        return reply.code(404).send(notFound("Chat does not exist!"));
      }
      await this.service.leaveGroup(request.params.guid);
      return success(undefined, "Successfully left chat!");
    });
    this.app.get<{ Params: { guid: string } }>("/api/v1/chat/:guid/share/contact/status", async (request, reply) => {
      if (!this.service.store.getChat(request.params.guid)) {
        return reply.code(404).send(notFound("Chat does not exist!"));
      }
      return success(false, "Successfully got contact sharing status!");
    });
    this.app.post<{ Params: { guid: string } }>("/api/v1/chat/:guid/typing", async (request, reply) => {
      if (!this.service.store.getChat(request.params.guid)) {
        return reply.code(404).send(notFound("Chat does not exist!"));
      }
      await this.service.setTyping(request.params.guid, true);
      return success(undefined, "Successfully started typing!");
    });
    this.app.delete<{ Params: { guid: string } }>("/api/v1/chat/:guid/typing", async (request, reply) => {
      if (!this.service.store.getChat(request.params.guid)) {
        return reply.code(404).send(notFound("Chat does not exist!"));
      }
      await this.service.setTyping(request.params.guid, false);
      return success(undefined, "Successfully stopped typing!");
    });

    this.app.get<{ Params: { guid: string }; Querystring: Query }>(
      "/api/v1/chat/:guid/message",
      async (request, reply) => {
        if (!this.service.store.getChat(request.params.guid)) {
          return reply.code(404).send(notFound("Chat does not exist!"));
        }
        const options = queryOptions(request.query, request.params.guid);
        const result = this.service.queryMessages(options);
        return success(result.messages, "Successfully fetched messages!", {
          offset: options.offset ?? 0,
          limit: options.limit ?? 100,
          total: result.total,
          count: result.messages.length,
        });
      },
    );

    this.app.post("/api/v1/chat/new", async (request) => {
      const body = asRecord(request.body);
      const addresses = Array.isArray(body.addresses) ? body.addresses.map(String) : [];
      if (addresses.length === 0) throw new RequestError(400, "No addresses provided!", "VALIDATION_ERROR");
      const guid = this.service.createChat(addresses);
      if (typeof body.message === "string" || typeof body.subject === "string") {
        const effectId = outboundEffectId(body.effectId, body.flair);
        await this.service.sendText({
          chatGuid: guid,
          message: typeof body.message === "string" ? body.message : "",
          ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
          ...(typeof body.tempGuid === "string" ? { tempGuid: body.tempGuid } : {}),
          ...(effectId ? { effectId } : {}),
        });
      }
      const chat = this.service.store.getChat(guid, true, true);
      return success(chat, "Successfully created chat!");
    });

    this.app.delete<{ Params: { guid: string; messageGuid: string } }>(
      "/api/v1/chat/:guid/:messageGuid",
      async (request, reply) => {
        if (!this.service.store.getChat(request.params.guid)) {
          return reply.code(404).send(notFound("Chat does not exist!"));
        }
        if (!await this.service.store.deleteMessage(request.params.guid, request.params.messageGuid)) {
          return reply.code(404).send(notFound("Message does not exist!"));
        }
        return success(undefined, "Successfully deleted message!");
      },
    );
    this.app.delete<{ Params: { guid: string } }>("/api/v1/chat/:guid", async (request, reply) => {
      if (!await this.service.store.deleteChat(request.params.guid)) {
        return reply.code(404).send(notFound("Chat does not exist!"));
      }
      return success(undefined, "Successfully deleted chat!");
    });

    this.app.post("/api/v1/message/query", async (request) => {
      const body = asRecord(request.body);
      const rowIds = rowIdQueryBounds(body.where);
      const options = {
        offset: numberValue(body.offset, 0),
        limit: numberValue(body.limit, 100),
        ...(typeof body.chatGuid === "string" ? { chatGuid: body.chatGuid } : {}),
        ...(body.before === undefined ? {} : { before: numberValue(body.before, 0) }),
        ...(body.after === undefined ? {} : { after: numberValue(body.after, 0) }),
        ...rowIds,
        sort: body.sort === "ASC" ? ("ASC" as const) : ("DESC" as const),
      };
      const result = this.service.queryMessages(options);
      return success(result.messages, "Successfully fetched messages!", {
        offset: options.offset,
        limit: options.limit,
        total: result.total,
        count: result.messages.length,
      });
    });

    this.app.get("/api/v1/message/schedule", async () =>
      success(this.service.scheduler.list()),
    );
    this.app.post("/api/v1/message/schedule", async (request) => {
      const message = this.service.scheduler.create(scheduledMessageDraft(request.body));
      return success(message, "Successfully created new scheduled message!");
    });
    this.app.get<{ Params: { id: string } }>("/api/v1/message/schedule/:id", async (request) => {
      const id = positiveInteger(request.params.id);
      // The pinned server returns a successful null when TypeORM does not find
      // the requested row; preserve that unusual read contract.
      return success(id === undefined ? null : this.service.scheduler.get(id) ?? null);
    });
    this.app.put<{ Params: { id: string } }>("/api/v1/message/schedule/:id", async (request, reply) => {
      const id = positiveInteger(request.params.id);
      const message = id === undefined
        ? undefined
        : this.service.scheduler.update(id, scheduledMessageDraft(request.body));
      if (!message) return reply.code(404).send(notFound("Scheduled message not found"));
      return success(message, "Successfully updated the scheduled message!");
    });
    this.app.delete<{ Params: { id: string } }>("/api/v1/message/schedule/:id", async (request, reply) => {
      const id = positiveInteger(request.params.id);
      const message = id === undefined ? undefined : this.service.scheduler.delete(id);
      if (!message) return reply.code(404).send(notFound("Scheduled message not found"));
      return success(undefined, "Successfully deleted scheduled message!");
    });

    this.app.get<{ Params: { guid: string } }>("/api/v1/message/:guid", async (request, reply) => {
      const message = this.service.store.getMessage(request.params.guid);
      if (!message) return reply.code(404).send(notFound("Message does not exist!"));
      return success(message);
    });
    this.app.get<{ Params: { guid: string }; Querystring: Query }>(
      "/api/v1/iblue/message/:guid/receipts",
      async (request, reply) => {
        if (!this.service.store.getMessage(request.params.guid)) {
          return reply.code(404).send(notFound("Message does not exist!"));
        }
        const type = request.query.type;
        if (type !== undefined && type !== "delivered" && type !== "read") {
          throw new RequestError(400, "type must be delivered or read", "VALIDATION_ERROR");
        }
        const offset = Math.max(Math.trunc(numberValue(request.query.offset, 0)), 0);
        const limit = Math.min(Math.max(Math.trunc(numberValue(request.query.limit, 100)), 1), 1000);
        const result = this.service.store.queryMessageReceipts(request.params.guid, {
          ...(type ? { type } : {}),
          ...(request.query.handle ? { handle: request.query.handle } : {}),
          offset,
          limit,
        });
        return success(result.receipts, "Successfully fetched message receipts!", {
          total: result.total,
          offset,
          limit,
          count: result.receipts.length,
        });
      },
    );

    // BlueBubbles accepts both a path-parameter and a body-parameter spelling
    // of edit and unsend, and clients pick either one. Both spellings share a
    // handler here so the pair cannot drift apart.
    const editMessage = async (messageGuid: string, body: Record<string, unknown>) => {
      const editedMessage = requiredString(body, "editedMessage");
      const message = await this.service.editMessage({
        messageGuid,
        editedMessage,
        ...(body.partIndex === undefined ? {} : { partIndex: numberValue(body.partIndex, 0) }),
      });
      return success(message, "Message edited!");
    };
    const unsendMessage = async (messageGuid: string, body: Record<string, unknown>) => {
      const message = await this.service.unsendMessage({
        messageGuid,
        ...(body.partIndex === undefined ? {} : { partIndex: numberValue(body.partIndex, 0) }),
      });
      return success(message, "Message unsent!");
    };

    this.app.post<{ Params: { guid: string } }>("/api/v1/message/:guid/edit", async (request) =>
      editMessage(request.params.guid, asRecord(request.body)),
    );
    this.app.post("/api/v1/message/edit", async (request) => {
      const body = asRecord(request.body);
      return editMessage(requiredString(body, "messageGuid"), body);
    });

    this.app.post<{ Params: { guid: string } }>("/api/v1/message/:guid/unsend", async (request) =>
      unsendMessage(request.params.guid, asRecord(request.body)),
    );
    this.app.post("/api/v1/message/delete", async (request) => {
      const body = asRecord(request.body);
      return unsendMessage(requiredString(body, "messageGuid"), body);
    });
    this.app.post<{ Params: { guid: string } }>("/api/v1/message/:guid/notify", async (request) => {
      return success(await this.service.notifyMessage(request.params.guid));
    });
    this.app.get<{ Params: { guid: string } }>("/api/v1/message/:guid/embedded-media", async (request, reply) => {
      const message = this.service.store.getMessage(request.params.guid);
      if (!message) return reply.code(400).send(
        failure(400, "Selected message does not exist!", "Validation Error", "Selected message does not exist!"),
      );
      const stored = message.attachments
        .map((attachment) => this.service.store.getAttachment(attachment.guid))
        .find((attachment) => attachment?.path);
      if (!stored?.path) return reply.code(404).send(notFound("No embedded media found!"));
      reply.header("content-type", stored.response.mimeType || "application/octet-stream");
      return reply.send(await readFile(stored.path));
    });

    this.app.post("/api/v1/message/text", async (request) => {
      const body = asRecord(request.body);
      const chatGuid = requiredString(body, "chatGuid");
      if (typeof body.message !== "string") {
        throw new RequestError(400, "A 'message' is required", "VALIDATION_ERROR");
      }
      const effectId = outboundEffectId(body.effectId, body.flair);
      const attributedBody = outboundAttributedBody(body, body.message);
      const message = await this.service.sendText({
        chatGuid,
        message: body.message,
        ...(typeof body.tempGuid === "string" ? { tempGuid: body.tempGuid } : {}),
        ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
        ...(effectId ? { effectId } : {}),
        ...(typeof body.selectedMessageGuid === "string"
          ? { selectedMessageGuid: body.selectedMessageGuid }
          : {}),
        ...(body.partIndex === undefined ? {} : { partIndex: numberValue(body.partIndex, 0) }),
        ...(attributedBody ? { attributedBody } : {}),
      });
      return success(message, "Message sent!");
    });

    this.app.post("/api/v1/message/react", async (request) => {
      const body = asRecord(request.body);
      const reaction = requiredString(body, "reaction") as IBlueReactionRequest;
      const allowed: IBlueReactionRequest[] = [
        "love", "like", "dislike", "laugh", "emphasize", "question",
        "-love", "-like", "-dislike", "-laugh", "-emphasize", "-question",
        "emoji", "-emoji",
      ];
      if (!allowed.includes(reaction)) throw new RequestError(400, "Invalid reaction!", "VALIDATION_ERROR");
      const emoji = emojiForReaction(reaction, body.emoji);
      const message = await this.service.sendReaction({
        chatGuid: requiredString(body, "chatGuid"),
        selectedMessageGuid: requiredString(body, "selectedMessageGuid"),
        reaction,
        ...(emoji ? { emoji } : {}),
        ...(body.partIndex === undefined ? {} : { partIndex: numberValue(body.partIndex, 0) }),
      });
      return success(message, "Reaction sent!");
    });

    this.app.post("/api/v1/iblue/message/sticker", async (request) => {
      const file = await request.file();
      if (!file || file.fieldname !== "sticker") {
        throw new RequestError(400, "Sticker image not provided or was empty!", "VALIDATION_ERROR");
      }
      const directory = await mkdtemp(join(tmpdir(), "iblue-sticker-"));
      const filename = safeAttachmentName(multipartField(file, "filename") ?? file.filename);
      const path = join(directory, filename);
      try {
        const size = await saveMultipartFile(file, path);
        if (size === 0 || size > 500 * 1024) {
          throw new RequestError(400, "Sticker image must be between 1 byte and 500 KB", "VALIDATION_ERROR");
        }
        const chatGuid = multipartField(file, "chatGuid");
        const selectedMessageGuid = multipartField(file, "selectedMessageGuid");
        if (!chatGuid) throw new RequestError(400, "chatGuid is required", "VALIDATION_ERROR");
        if (!selectedMessageGuid) {
          throw new RequestError(400, "selectedMessageGuid is required", "VALIDATION_ERROR");
        }
        const sourceValue = multipartField(file, "source") ?? "sticker";
        if (sourceValue !== "sticker" && sourceValue !== "memoji" && sourceValue !== "genmoji") {
          throw new RequestError(400, "source must be sticker, memoji, or genmoji", "VALIDATION_ERROR");
        }
        const rawPartIndex = multipartField(file, "partIndex");
        const partIndex = rawPartIndex === undefined ? 0 : Number(rawPartIndex);
        if (!Number.isSafeInteger(partIndex) || partIndex < 0) {
          throw new RequestError(400, "partIndex must be a non-negative integer", "VALIDATION_ERROR");
        }
        const mimeType = file.mimetype || mimeForFilename(filename);
        const allowedMimeTypes = new Set(["image/png", "image/gif", "image/jpeg", "image/heic", "image/heif"]);
        if (!allowedMimeTypes.has(mimeType)) {
          throw new RequestError(400, "Sticker image must be PNG, GIF, JPEG, HEIC, or HEIF", "VALIDATION_ERROR");
        }
        const message = await this.service.sendStickerReaction({
          chatGuid,
          selectedMessageGuid,
          targetPart: partIndex,
          path,
          filename,
          mimeType,
          utiType: utiForMime(mimeType),
          source: sourceValue,
        });
        return success(message, "Sticker reaction sent!");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    this.app.post("/api/v1/iblue/message/sticker/update", async (request) => {
      const body = asRecord(request.body);
      const scale = numberValue(body.scale, Number.NaN);
      if (!Number.isFinite(scale) || scale < 0.05 || scale > 2) {
        throw new RequestError(400, "scale must be between 0.05 and 2", "VALIDATION_ERROR");
      }
      const result = await this.service.updateStickerReaction({
        chatGuid: requiredString(body, "chatGuid"),
        messageGuid: requiredString(body, "messageGuid"),
        scale,
      });
      return success(result, "Sticker updated!");
    });

    this.app.post("/api/v1/message/attachment", async (request) => {
      const file = await request.file();
      if (!file || file.fieldname !== "attachment") {
        throw new RequestError(400, "Attachment not provided or was empty!", "VALIDATION_ERROR");
      }
      const directory = await mkdtemp(join(tmpdir(), "iblue-upload-"));
      const name = safeAttachmentName(multipartField(file, "name") ?? file.filename);
      const path = join(directory, name);
      try {
        if (await saveMultipartFile(file, path) === 0) {
          throw new RequestError(400, "Attachment not provided or was empty!", "VALIDATION_ERROR");
        }
        const chatGuid = multipartField(file, "chatGuid");
        if (!chatGuid) throw new RequestError(400, "chatGuid is required", "VALIDATION_ERROR");
        const tempGuid = multipartField(file, "tempGuid");
        const caption = multipartField(file, "subject");
        const effectId = multipartField(file, "effectId");
        const flair = multipartField(file, "flair");
        const resolvedEffectId = outboundEffectId(effectId, flair);
        const isAudioMessage = multipartField(file, "isAudioMessage") === "true";
        const replyGuid = multipartField(file, "selectedMessageGuid");
        const replyPart = multipartField(file, "partIndex");
        const message = await this.service.sendAttachment({
          chatGuid,
          path,
          filename: name,
          mimeType: file.mimetype || "application/octet-stream",
          utiType: utiForMime(file.mimetype),
          ...(tempGuid ? { tempGuid } : {}),
          ...(caption ? { caption } : {}),
          ...(resolvedEffectId ? { effectId: resolvedEffectId } : {}),
          ...(isAudioMessage ? { isAudioMessage: true } : {}),
          ...(replyGuid ? { replyGuid } : {}),
          ...(replyPart ? { replyPart } : {}),
        });
        return success(message, "Attachment sent!");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    this.app.post("/api/v1/message/multipart", async (request) => {
      const body = asRecord(request.body);
      const chatGuid = requiredString(body, "chatGuid");
      if (!Array.isArray(body.parts) || body.parts.length === 0) {
        throw new RequestError(400, "parts is required", "VALIDATION_ERROR");
      }
      const stagedDirectories = new Set<string>();
      const parts = await Promise.all(body.parts.map(async (value) => {
        const part = asRecord(value);
        if (typeof part.partIndex !== "number" || !Number.isInteger(part.partIndex) || part.partIndex < 0) {
          throw new RequestError(400, "Each partIndex must be a non-negative number", "VALIDATION_ERROR");
        }
        const text = typeof part.text === "string" && part.text.length > 0 ? part.text : undefined;
        const attachment = typeof part.attachment === "string" && part.attachment.length > 0
          ? part.attachment
          : undefined;
        if (!text && !attachment) {
          throw new RequestError(400, "Each part must have either a text or attachment", "VALIDATION_ERROR");
        }
        if (attachment) {
          const name = typeof part.name === "string" && part.name.length > 0
            ? safeAttachmentName(part.name)
            : undefined;
          if (!name) {
            throw new RequestError(400, "Each attachment must have a name", "VALIDATION_ERROR");
          }
          const staged = this.resolveMultipartUpload(attachment);
          const info = await stat(staged.path).catch(() => undefined);
          if (!info?.isFile() || info.size === 0) {
            throw new RequestError(400, `Attachment '${attachment}' does not exist`, "VALIDATION_ERROR");
          }
          stagedDirectories.add(staged.directory);
          const mimeType = mimeForFilename(name);
          return {
            partIndex: part.partIndex,
            path: staged.path,
            filename: name,
            mimeType,
            utiType: utiForMime(mimeType),
          };
        }
        const mention = typeof part.mention === "string" && part.mention.length > 0
          ? part.mention
          : undefined;
        if (mention && !text) {
          throw new RequestError(400, "A mention must have text", "VALIDATION_ERROR");
        }
        return {
          partIndex: part.partIndex,
          text: text!,
          ...(mention ? { mention } : {}),
        };
      }));

      const effectId = outboundEffectId(body.effectId, body.flair);
      const message = await this.service.sendMultipart({
        chatGuid,
        parts,
        ...(typeof body.tempGuid === "string" ? { tempGuid: body.tempGuid } : {}),
        ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
        ...(effectId ? { effectId } : {}),
        ...(typeof body.selectedMessageGuid === "string"
          ? { replyGuid: body.selectedMessageGuid }
          : {}),
        ...(body.partIndex === undefined ? {} : { replyPart: String(numberValue(body.partIndex, 0)) }),
        ...(typeof body.ddScan === "boolean" ? { ddScan: body.ddScan } : {}),
      });
      await Promise.all([...stagedDirectories].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ));
      return success(message, "Message sent!");
    });

    this.app.get<{ Params: { guid: string } }>(
      "/api/v1/attachment/:guid/download",
      async (request, reply) => this.sendAttachmentDownload(request.params.guid, reply),
    );
    // Direct IDS receive downloads MMCS content before it is exposed to the
    // API, so BlueBubbles' force-download route is an exact alias when the
    // local file exists and a normal 404 when it does not.
    this.app.get<{ Params: { guid: string } }>(
      "/api/v1/attachment/:guid/download/force",
      async (request, reply) => this.sendAttachmentDownload(request.params.guid, reply),
    );
    this.app.get<{ Params: { guid: string } }>("/api/v1/attachment/:guid", async (request, reply) => {
      const attachment = this.service.store.getAttachment(request.params.guid);
      if (!attachment) return reply.code(404).send(notFound("Attachment does not exist!"));
      return success(attachment.response);
    });

    this.app.get<{ Querystring: Query }>("/api/v1/webhook", async (request) => {
      const id = request.query.id ? Number(request.query.id) : undefined;
      return success(
        this.service.store.listWebhooks({
          ...(id !== undefined && Number.isFinite(id) ? { id } : {}),
          ...(request.query.url ? { url: request.query.url } : {}),
        }),
        "Successfully fetched webhooks!",
      );
    });
    this.app.post("/api/v1/webhook", async (request) => {
      const body = asRecord(request.body);
      const url = requiredString(body, "url");
      const events = Array.isArray(body.events) ? body.events.map(String) : [];
      if (!/^https?:\/\//.test(url)) throw new RequestError(400, "Webhook URL must include an HTTP scheme!", "VALIDATION_ERROR");
      if (events.length === 0 || events.some((event) => !WEBHOOK_EVENTS.has(event))) {
        throw new RequestError(400, "Invalid webhook events!", "VALIDATION_ERROR");
      }
      return success(this.service.store.createWebhook(url, events), "Successfully created webhook!");
    });
    this.app.delete<{ Params: { id: string } }>("/api/v1/webhook/:id", async (request, reply) => {
      if (!this.service.store.deleteWebhook(Number(request.params.id))) {
        return reply.code(404).send(notFound("Webhook does not exist!"));
      }
      return success(null, "Successfully deleted webhook!");
    });

    this.app.all("/api/v1/*", async (request, reply) => {
      return reply.code(501).send(unsupported(`${request.method} ${request.url.split("?")[0]}`));
    });
  }

  private configureErrors(): void {
    this.app.setErrorHandler((error, _request, reply) => {
      if (error instanceof StickerUnsendUnsupportedError) {
        void reply.code(400).send(
          failure(400, error.message, "Validation Error", "STICKER_UNSEND_UNSUPPORTED"),
        );
        return;
      }
      if (error instanceof RequestError) {
        void reply.code(error.status).send(
          failure(
            error.status,
            error.message,
            [400, 415].includes(error.status) ? "Validation Error" : "iMessage Error",
            error.code,
          ),
        );
        return;
      }
      this.app.log.error(error);
      const message = error instanceof Error ? error.message : String(error);
      void reply.code(500).send(failure(500, "iMessage has encountered an error", "iMessage Error", message));
    });
  }

  private configureSocket(io: SocketIoServer): void {
    io.on("connection", (socket) => {
      const raw = socket.handshake.query.password ?? socket.handshake.query.guid;
      const supplied = Array.isArray(raw) ? raw[0] : raw;
      if (!supplied || safeDecode(String(supplied)).trim() !== this.service.password.trim()) {
        socket.disconnect(true);
        return;
      }
      this.configureSocketRequests(socket);
    });
  }

  private routeFaceTimeMediaFrame(frame: NativeFaceTimeMediaFrame): void {
    const now = Date.now();
    const data = Buffer.from(frame.dataBase64, "base64");
    for (const [socketId, subscriptions] of this.#faceTimeSocketSubscriptions) {
      const subscription = [...subscriptions.values()].find((candidate) =>
        candidate.sessionId === frame.sessionId
        && candidate.expiresAt > now
        && (frame.kind === "audio" ? candidate.audio : candidate.video));
      if (!subscription) continue;
      this.#socket?.sockets.sockets.get(socketId)?.emit("ft-media-frame", {
        ...(subscription.callId ? { callId: subscription.callId } : {}),
        subscriptionId: subscription.subscriptionId,
        sessionId: frame.sessionId,
        kind: frame.kind,
        codec: frame.codec,
        ...(frame.payloadType === undefined ? {} : { payloadType: frame.payloadType }),
        ...(frame.rtpTimestamp === undefined ? {} : { rtpTimestamp: frame.rtpTimestamp }),
        ...(frame.durationMs === undefined ? {} : { durationMs: frame.durationMs }),
        ...(frame.droppedPackets === undefined ? {} : { droppedPackets: frame.droppedPackets }),
        receivedAt: frame.receivedAt,
        data,
      });
    }
  }

  private async refreshNativeFaceTimeStream(sessionId: string): Promise<void> {
    if (!this.service.nativeFaceTimeStreamingAvailable) return;
    const now = Date.now();
    const active = [...this.#faceTimeSocketSubscriptions.values()]
      .flatMap((subscriptions) => [...subscriptions.values()])
      .filter((subscription) => subscription.sessionId === sessionId && subscription.expiresAt > now);
    if (active.length === 0) {
      await this.service.setNativeFaceTimeMediaStream({ sessionId, enabled: false });
      return;
    }
    const expiresAt = Math.max(...active.map((subscription) => subscription.expiresAt));
    await this.service.setNativeFaceTimeMediaStream({
      sessionId,
      enabled: true,
      audio: active.some((subscription) => subscription.audio),
      video: active.some((subscription) => subscription.video),
      ttlSeconds: Math.min(3_600, Math.max(5, Math.ceil((expiresAt - now) / 1_000))),
    });
  }

  private removeFaceTimeSubscription(socketId: string, subscriptionId: string): string | undefined {
    const subscriptions = this.#faceTimeSocketSubscriptions.get(socketId);
    const subscription = subscriptions?.get(subscriptionId);
    if (!subscription) return undefined;
    clearTimeout(subscription.timer);
    subscriptions!.delete(subscriptionId);
    if (subscriptions!.size === 0) this.#faceTimeSocketSubscriptions.delete(socketId);
    return subscription.sessionId;
  }

  private async revokeFaceTimeSubscriptions(sessionId: string): Promise<void> {
    for (const [socketId, subscriptions] of this.#faceTimeSocketSubscriptions) {
      for (const subscription of [...subscriptions.values()]) {
        if (subscription.sessionId === sessionId) {
          this.removeFaceTimeSubscription(socketId, subscription.subscriptionId);
        }
      }
    }
    if (this.service.nativeFaceTimeStreamingAvailable) {
      await this.service.setNativeFaceTimeMediaStream({ sessionId, enabled: false }).catch((error) =>
        this.app.log.error(error));
    }
  }

  private configureSocketRequests(socket: Socket): void {
    const uploads = new Map<string, SocketUpload>();
    const response = (callback: unknown, channel: string, payload: BlueBubblesResponse): void => {
      const wirePayload = { ...payload, encrypted: false };
      if (typeof callback === "function") callback(wirePayload);
      else socket.emit(channel, wirePayload);
    };
    socket.on("facetime-call-list", (_params, callback) =>
      response(callback, "facetime-call-list", success(this.#faceTimeMedia?.list() ?? [])));
    socket.on("facetime-call-get", (params, callback) => {
      const body = asRecord(params);
      const call = typeof body.callId === "string" ? this.#faceTimeMedia?.get(body.callId) : undefined;
      response(
        callback,
        call ? "facetime-call-get" : "error",
        call ? success(call) : notFound("FaceTime media call not found!"),
      );
    });
    socket.on("facetime-call-stop", (params, callback) => {
      const body = asRecord(params);
      const callId = typeof body.callId === "string" ? body.callId : "";
      if (!this.#faceTimeMedia) {
        response(callback, "error", unsupported("Socket.IO facetime-call-stop"));
        return;
      }
      void this.#faceTimeMedia.stop(callId)
        .then(async (call) => {
          this.#faceTimeLiveAudioOwners.delete(callId);
          if (call?.sessionId && (call.state === "ended" || call.state === "failed")) {
            await this.revokeFaceTimeSubscriptions(call.sessionId);
          }
          response(
            callback,
            call ? "facetime-call-stop" : "error",
            call ? success(call) : notFound("FaceTime media call not found!"),
          );
        })
        .catch((error: Error) => response(
          callback,
          "error",
          failure(500, "Failed to stop FaceTime call", "FaceTime Error", error.message),
        ));
    });
    socket.on("facetime-incoming-list", (_params, callback) => {
      void this.service.listIncomingFaceTimeSessions()
        .then((sessions) => response(
          callback,
          "facetime-incoming-list",
          success(sessions, "Incoming FaceTime sessions fetched"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(500, error.message, "FaceTime Incoming Error", error.message),
        ));
    });
    socket.on("facetime-incoming-answer", (params, callback) => {
      const body = asRecord(params);
      void (async () => {
        const sessionId = requiredString(body, "sessionId");
        const session = await this.service.answerIncomingFaceTimeSession({ sessionId });
        this.service.dispatch("ft-call-status-changed", {
          ...session,
          direction: "incoming",
          status: "active",
        });
        return session;
      })()
        .then((session) => response(
          callback,
          "facetime-incoming-answer",
          success(session, "Incoming FaceTime call answered"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(
            error instanceof RequestError ? error.status : 500,
            error.message,
            "FaceTime Incoming Error",
            error.message,
          ),
        ));
    });
    socket.on("facetime-live-audio-start", (params, callback) => {
      const body = asRecord(params);
      void (async () => {
        if (!this.service.nativeFaceTimeLiveAudioAvailable) {
          throw new RequestError(501, "Native FaceTime live audio is unavailable", "UNSUPPORTED");
        }
        const sessionId = requiredString(body, "sessionId");
        const incoming = (await this.service.listIncomingFaceTimeSessions())
          .find((session) => session.sessionId === sessionId);
        if (!incoming) {
          throw new RequestError(404, "Incoming FaceTime session not found", "NOT_FOUND");
        }
        if (incoming.state !== "active" || !incoming.nativeMediaAttached) {
          throw new RequestError(
            409,
            "Incoming FaceTime session must be answered by iBlue before streaming",
            "INVALID_STATE",
          );
        }
        const owner = this.#faceTimeIncomingLiveOwners.get(sessionId);
        if (owner && owner.socketId !== socket.id) {
          throw new RequestError(403, "Another socket owns this incoming call", "FORBIDDEN");
        }
        this.#faceTimeIncomingLiveOwners.set(sessionId, {
          socketId: socket.id,
          audio: true,
          video: owner?.video ?? false,
        });
        try {
          return await this.service.startNativeFaceTimeLiveAudioStream(sessionId);
        } catch (error) {
          const current = this.#faceTimeIncomingLiveOwners.get(sessionId);
          if (current?.socketId === socket.id) {
            if (current.video) current.audio = false;
            else this.#faceTimeIncomingLiveOwners.delete(sessionId);
          }
          throw error;
        }
      })()
        .then((result) => response(
          callback,
          "facetime-live-audio-start",
          success(result, "Incoming FaceTime live audio started"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(
            error instanceof RequestError ? error.status : 500,
            error.message,
            "FaceTime Live Audio Error",
            error.message,
          ),
        ));
    });
    socket.on("facetime-live-audio-session-frame", (params, callback) => {
      const body = asRecord(params);
      void (async () => {
        const sessionId = requiredString(body, "sessionId");
        const owner = this.#faceTimeIncomingLiveOwners.get(sessionId);
        if (owner?.socketId !== socket.id || !owner.audio) {
          throw new RequestError(403, "This socket does not own the live audio stream", "FORBIDDEN");
        }
        const data = body.data;
        if (!Buffer.isBuffer(data) || data.length !== 1_920) {
          throw new RequestError(
            400,
            "data must be a 1920-byte Socket.IO binary Buffer (24 kHz mono float32 LE, 20 ms)",
            "VALIDATION_ERROR",
          );
        }
        return this.service.pushNativeFaceTimeLiveAudioFrame(sessionId, data);
      })()
        .then((result) => response(
          callback,
          "facetime-live-audio-session-frame",
          success(result, "Incoming FaceTime live audio frame accepted"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(
            error instanceof RequestError ? error.status : 500,
            error.message,
            "FaceTime Live Audio Error",
            error.message,
          ),
        ));
    });
    socket.on("facetime-live-audio-session-finish", (params, callback) => {
      const body = asRecord(params);
      void (async () => {
        const sessionId = requiredString(body, "sessionId");
        const owner = this.#faceTimeIncomingLiveOwners.get(sessionId);
        if (owner?.socketId !== socket.id || !owner.audio) {
          throw new RequestError(403, "This socket does not own the live audio stream", "FORBIDDEN");
        }
        const result = await this.service.finishNativeFaceTimeLiveAudioStream(sessionId);
        owner.audio = false;
        if (!owner.video) this.#faceTimeIncomingLiveOwners.delete(sessionId);
        return result;
      })()
        .then((result) => response(
          callback,
          "facetime-live-audio-session-finish",
          success(result, "Incoming FaceTime live audio ended"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(
            error instanceof RequestError ? error.status : 500,
            error.message,
            "FaceTime Live Audio Error",
            error.message,
          ),
        ));
    });
    socket.on("facetime-live-video-start", (params, callback) => {
      const body = asRecord(params);
      void (async () => {
        if (!this.service.nativeFaceTimeLiveVideoAvailable) {
          throw new RequestError(501, "Native FaceTime live video is unavailable", "UNSUPPORTED");
        }
        const sessionId = requiredString(body, "sessionId");
        const incoming = (await this.service.listIncomingFaceTimeSessions())
          .find((session) => session.sessionId === sessionId);
        if (!incoming) {
          throw new RequestError(404, "Incoming FaceTime session not found", "NOT_FOUND");
        }
        if (incoming.state !== "active" || !incoming.nativeMediaAttached) {
          throw new RequestError(
            409,
            "Incoming FaceTime session must be answered by iBlue before streaming",
            "INVALID_STATE",
          );
        }
        if (incoming.mode !== "video") {
          throw new RequestError(409, "Live video requires an incoming FaceTime Video call", "INVALID_STATE");
        }
        const imageDescription = body.imageDescription;
        if (!Buffer.isBuffer(imageDescription)) {
          throw new RequestError(
            400,
            "imageDescription must be a Socket.IO binary Buffer containing one hvc1 sample entry",
            "VALIDATION_ERROR",
          );
        }
        const frameDurationMs = body.frameDurationMs === undefined
          ? 40
          : numberValue(body.frameDurationMs, Number.NaN);
        if (!Number.isSafeInteger(frameDurationMs) || frameDurationMs < 20 || frameDurationMs > 100) {
          throw new RequestError(
            400,
            "frameDurationMs must be an integer between 20 and 100",
            "VALIDATION_ERROR",
          );
        }
        const owner = this.#faceTimeIncomingLiveOwners.get(sessionId);
        if (owner && owner.socketId !== socket.id) {
          throw new RequestError(403, "Another socket owns this incoming call", "FORBIDDEN");
        }
        this.#faceTimeIncomingLiveOwners.set(sessionId, {
          socketId: socket.id,
          audio: owner?.audio ?? false,
          video: true,
        });
        try {
          return await this.service.startNativeFaceTimeLiveVideoStream({
            sessionId,
            imageDescription,
            frameDurationMs,
          });
        } catch (error) {
          const current = this.#faceTimeIncomingLiveOwners.get(sessionId);
          if (current?.socketId === socket.id) {
            if (current.audio) current.video = false;
            else this.#faceTimeIncomingLiveOwners.delete(sessionId);
          }
          throw error;
        }
      })()
        .then((result) => response(
          callback,
          "facetime-live-video-start",
          success(result, "Incoming FaceTime live video started"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(
            error instanceof RequestError ? error.status : 500,
            error.message,
            "FaceTime Live Video Error",
            error.message,
          ),
        ));
    });
    socket.on("facetime-live-video-frame", (params, callback) => {
      const body = asRecord(params);
      void (async () => {
        const sessionId = requiredString(body, "sessionId");
        const owner = this.#faceTimeIncomingLiveOwners.get(sessionId);
        if (owner?.socketId !== socket.id || !owner.video) {
          throw new RequestError(403, "This socket does not own the live video stream", "FORBIDDEN");
        }
        const data = body.data;
        if (!Buffer.isBuffer(data) || data.length === 0 || data.length > 4 * 1024 * 1024) {
          throw new RequestError(
            400,
            "data must be a Socket.IO binary Buffer containing one Annex-B H.265 access unit (maximum 4 MiB)",
            "VALIDATION_ERROR",
          );
        }
        return this.service.pushNativeFaceTimeLiveVideoFrame(sessionId, data);
      })()
        .then((result) => response(
          callback,
          "facetime-live-video-frame",
          success(result, "Incoming FaceTime live video frame accepted"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(
            error instanceof RequestError ? error.status : 500,
            error.message,
            "FaceTime Live Video Error",
            error.message,
          ),
        ));
    });
    socket.on("facetime-live-video-finish", (params, callback) => {
      const body = asRecord(params);
      void (async () => {
        const sessionId = requiredString(body, "sessionId");
        const owner = this.#faceTimeIncomingLiveOwners.get(sessionId);
        if (owner?.socketId !== socket.id || !owner.video) {
          throw new RequestError(403, "This socket does not own the live video stream", "FORBIDDEN");
        }
        const result = await this.service.finishNativeFaceTimeLiveVideoStream(sessionId);
        owner.video = false;
        if (!owner.audio) this.#faceTimeIncomingLiveOwners.delete(sessionId);
        return result;
      })()
        .then((result) => response(
          callback,
          "facetime-live-video-finish",
          success(result, "Incoming FaceTime live video ended"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(
            error instanceof RequestError ? error.status : 500,
            error.message,
            "FaceTime Live Video Error",
            error.message,
          ),
        ));
    });
    socket.on("facetime-incoming-decline", (params, callback) => {
      const body = asRecord(params);
      void (async () => {
        const sessionId = requiredString(body, "sessionId");
        const session = await this.service.declineIncomingFaceTimeSession(sessionId);
        this.service.dispatch("ft-call-status-changed", {
          ...session,
          direction: "incoming",
          status: "declined",
        });
        return session;
      })()
        .then((session) => response(
          callback,
          "facetime-incoming-decline",
          success(session, "Incoming FaceTime call declined"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(
            error instanceof RequestError ? error.status : 500,
            error.message,
            "FaceTime Incoming Error",
            error.message,
          ),
        ));
    });
    socket.on("facetime-incoming-leave", (params, callback) => {
      const body = asRecord(params);
      void (async () => {
        const sessionId = requiredString(body, "sessionId");
        const result = await this.service.leaveFaceTimeSession(sessionId);
        await this.revokeFaceTimeSubscriptions(sessionId);
        this.#faceTimeIncomingLiveOwners.delete(sessionId);
        this.service.dispatch("ft-call-status-changed", {
          sessionId,
          direction: "incoming",
          status: "ended",
        });
        return result;
      })()
        .then((result) => response(
          callback,
          "facetime-incoming-leave",
          success(result, "Incoming FaceTime call ended"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(
            error instanceof RequestError ? error.status : 500,
            error.message,
            "FaceTime Incoming Error",
            error.message,
          ),
        ));
    });
    socket.on("facetime-live-audio-create", (params, callback) => {
      const body = asRecord(params);
      void (async () => {
        if (
          !this.service.nativeFaceTimeLiveAudioAvailable
          || !this.#faceTimeMedia?.startLiveAudio
          || !this.#faceTimeMedia.pushLiveAudioFrame
          || !this.#faceTimeMedia.finishLiveAudio
        ) {
          throw new RequestError(501, "Native FaceTime live audio is unavailable", "UNSUPPORTED");
        }
        const rawTarget = typeof body.target === "string"
          ? body.target
          : requiredString(body, "address");
        const target = rawTarget.trim();
        if (!target) {
          throw new RequestError(400, "target or address is required", "VALIDATION_ERROR");
        }
        const maxDurationSeconds = body.maxDurationSeconds === undefined
          ? undefined
          : numberValue(body.maxDurationSeconds, Number.NaN);
        if (maxDurationSeconds !== undefined && (
          !Number.isSafeInteger(maxDurationSeconds)
          || maxDurationSeconds < 15
          || maxDurationSeconds > 600
        )) {
          throw new RequestError(
            400,
            "maxDurationSeconds must be an integer between 15 and 600",
            "VALIDATION_ERROR",
          );
        }
        const call = await this.#faceTimeMedia.startLiveAudio({
          targets: [target.startsWith("tel:") || target.startsWith("mailto:")
            ? target
            : toTransportAddress(target)],
          displayName: typeof body.displayName === "string" ? body.displayName : "iBlue",
          ...(typeof body.from === "string" ? { from: toTransportAddress(body.from) } : {}),
          ...(maxDurationSeconds === undefined ? {} : { maxDurationSeconds }),
        });
        this.#faceTimeLiveAudioOwners.set(call.id, socket.id);
        return call;
      })()
        .then((call) => response(
          callback,
          "facetime-live-audio-create",
          success(call, "FaceTime live audio call is ringing"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(
            error instanceof RequestError ? error.status : 500,
            error.message,
            "FaceTime Live Audio Error",
            error.message,
          ),
        ));
    });
    socket.on("facetime-live-audio-frame", (params, callback) => {
      const body = asRecord(params);
      void (async () => {
        const callId = requiredString(body, "callId");
        if (this.#faceTimeLiveAudioOwners.get(callId) !== socket.id) {
          throw new RequestError(403, "This socket does not own the live audio call", "FORBIDDEN");
        }
        if (!this.#faceTimeMedia?.pushLiveAudioFrame) {
          throw new RequestError(501, "Native FaceTime live audio is unavailable", "UNSUPPORTED");
        }
        const data = body.data;
        if (!Buffer.isBuffer(data)) {
          throw new RequestError(
            400,
            "data must be a Socket.IO binary Buffer",
            "VALIDATION_ERROR",
          );
        }
        if (data.length !== 1_920) {
          throw new RequestError(
            400,
            "PCM frame must be exactly 1920 bytes (24 kHz mono float32 LE, 20 ms)",
            "VALIDATION_ERROR",
          );
        }
        return this.#faceTimeMedia.pushLiveAudioFrame(callId, data);
      })()
        .then((call) => response(
          callback,
          "facetime-live-audio-frame",
          success(call, "FaceTime live audio frame accepted"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(
            error instanceof RequestError ? error.status : 500,
            error.message,
            "FaceTime Live Audio Error",
            error.message,
          ),
        ));
    });
    socket.on("facetime-live-audio-finish", (params, callback) => {
      const body = asRecord(params);
      void (async () => {
        const callId = requiredString(body, "callId");
        if (this.#faceTimeLiveAudioOwners.get(callId) !== socket.id) {
          throw new RequestError(403, "This socket does not own the live audio call", "FORBIDDEN");
        }
        if (!this.#faceTimeMedia?.finishLiveAudio) {
          throw new RequestError(501, "Native FaceTime live audio is unavailable", "UNSUPPORTED");
        }
        const call = await this.#faceTimeMedia.finishLiveAudio(callId);
        this.#faceTimeLiveAudioOwners.delete(callId);
        if (!call) throw new RequestError(404, "FaceTime media call not found", "NOT_FOUND");
        return call;
      })()
        .then((call) => response(
          callback,
          "facetime-live-audio-finish",
          success(call, "FaceTime live audio call ended"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(
            error instanceof RequestError ? error.status : 500,
            error.message,
            "FaceTime Live Audio Error",
            error.message,
          ),
        ));
    });
    socket.on("facetime-media-subscribe", (params, callback) => {
      const body = asRecord(params);
      void (async () => {
        if (!this.service.nativeFaceTimeStreamingAvailable) {
          throw new RequestError(501, "Native FaceTime media streaming is unavailable", "UNSUPPORTED");
        }
        const callId = typeof body.callId === "string" && body.callId.trim()
          ? body.callId.trim()
          : undefined;
        const requestedSessionId = typeof body.sessionId === "string" && body.sessionId.trim()
          ? body.sessionId.trim()
          : undefined;
        if (!callId && !requestedSessionId) {
          throw new RequestError(400, "callId or sessionId is required", "VALIDATION_ERROR");
        }
        let sessionId: string;
        if (callId) {
          const call = this.#faceTimeMedia?.get(callId);
          if (!call) throw new RequestError(404, "FaceTime media call not found", "NOT_FOUND");
          if (!call.sessionId || call.transport !== "iblue-quickrelay") {
            throw new RequestError(409, "Call does not use native iBlue media", "INVALID_STATE");
          }
          if (call.state === "ended" || call.state === "failed") {
            throw new RequestError(409, "FaceTime media call has ended", "INVALID_STATE");
          }
          sessionId = call.sessionId;
        } else {
          const incoming = (await this.service.listIncomingFaceTimeSessions())
            .find((session) => session.sessionId === requestedSessionId);
          if (!incoming) {
            throw new RequestError(404, "Incoming FaceTime session not found", "NOT_FOUND");
          }
          if (incoming.state !== "active" || !incoming.nativeMediaAttached) {
            throw new RequestError(
              409,
              "Incoming FaceTime session must be answered by iBlue before subscribing",
              "INVALID_STATE",
            );
          }
          sessionId = incoming.sessionId;
        }
        const subscriptionId = callId ?? `session:${sessionId}`;
        const audio = body.audio === undefined ? true : Boolean(body.audio);
        const video = body.video === undefined ? false : Boolean(body.video);
        if (!audio && !video) {
          throw new RequestError(400, "At least one of audio or video is required", "VALIDATION_ERROR");
        }
        const ttlSeconds = body.ttlSeconds === undefined ? 300 : numberValue(body.ttlSeconds, Number.NaN);
        if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 5 || ttlSeconds > 3_600) {
          throw new RequestError(
            400,
            "ttlSeconds must be an integer between 5 and 3600",
            "VALIDATION_ERROR",
          );
        }
        const priorSessionId = this.removeFaceTimeSubscription(socket.id, subscriptionId);
        if (priorSessionId && priorSessionId !== sessionId) {
          await this.refreshNativeFaceTimeStream(priorSessionId);
        }
        const expiresAt = Date.now() + ttlSeconds * 1_000;
        const timer = setTimeout(() => {
          const expiredSessionId = this.removeFaceTimeSubscription(socket.id, subscriptionId);
          if (expiredSessionId) void this.refreshNativeFaceTimeStream(expiredSessionId).catch((error) =>
            this.app.log.error(error));
        }, ttlSeconds * 1_000);
        timer.unref?.();
        const subscriptions = this.#faceTimeSocketSubscriptions.get(socket.id) ?? new Map();
        subscriptions.set(subscriptionId, {
          subscriptionId,
          ...(callId ? { callId } : {}),
          sessionId,
          audio,
          video,
          expiresAt,
          timer,
        });
        this.#faceTimeSocketSubscriptions.set(socket.id, subscriptions);
        try {
          await this.refreshNativeFaceTimeStream(sessionId);
        } catch (error) {
          this.removeFaceTimeSubscription(socket.id, subscriptionId);
          throw error;
        }
        return {
          subscriptionId,
          ...(callId ? { callId } : {}),
          sessionId,
          audio,
          video,
          expiresAt,
        };
      })()
        .then((subscription) => response(
          callback,
          "facetime-media-subscribe",
          success(subscription, "FaceTime media subscription enabled"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(
            error instanceof RequestError ? error.status : 500,
            error.message,
            "FaceTime Media Error",
            error.message,
          ),
        ));
    });
    socket.on("facetime-media-unsubscribe", (params, callback) => {
      const body = asRecord(params);
      void (async () => {
        const subscriptionId = typeof body.subscriptionId === "string" && body.subscriptionId.trim()
          ? body.subscriptionId.trim()
          : typeof body.callId === "string" && body.callId.trim()
            ? body.callId.trim()
            : typeof body.sessionId === "string" && body.sessionId.trim()
              ? `session:${body.sessionId.trim()}`
              : "";
        if (!subscriptionId) {
          throw new RequestError(
            400,
            "subscriptionId, callId, or sessionId is required",
            "VALIDATION_ERROR",
          );
        }
        const sessionId = this.removeFaceTimeSubscription(socket.id, subscriptionId);
        if (!sessionId) return false;
        await this.refreshNativeFaceTimeStream(sessionId);
        return true;
      })()
        .then((removed) => response(
          callback,
          "facetime-media-unsubscribe",
          success({ removed }, "FaceTime media subscription disabled"),
        ))
        .catch((error: Error) => response(
          callback,
          "error",
          failure(500, error.message, "FaceTime Media Error", error.message),
        ));
    });
    socket.on("get-server-metadata", (_params, callback) =>
      response(callback, "server-metadata", success(this.serverMetadata())),
    );
    socket.on("get-server-config", (_params, callback) => response(
      callback,
      "server-config",
      success({
        encrypt_coms: false,
        enable_private_api: true,
        proxy_service: "Manual",
        port: this.port,
        iBlue: {
          profile: this.service.profile,
          transport: "direct-ids",
          fcmSupported: false,
          contactsSource: "profile-local-vcf",
        },
      }, "Successfully fetched server config"),
    ));
    socket.on("get-fcm-client", (_params, callback) =>
      response(callback, "fcm-client", success(null, "FCM is not configured; use Socket.IO or webhooks")),
    );
    socket.on("get-logs", (_params, callback) => response(callback, "logs", success([])));
    socket.on("save-vcf", (params, callback) => {
      const body = asRecord(params);
      if (typeof body.vcf !== "string" || body.vcf.length === 0) {
        return response(
          callback,
          "error",
          failure(400, "No VCF data provided!", "Validation Error", "No VCF data provided!"),
        );
      }
      void this.saveContactsVcf(body.vcf)
        .then(() => response(callback, "save-vcf", success(null, "Successfully saved VCF")))
        .catch((error: Error) => response(callback, "error", failure(500, error.message, "Server Error", error.message)));
    });
    socket.on("get-vcf", (_params, callback) => {
      void this.loadContactsVcf()
        // The pinned server uses the save-vcf response channel for get-vcf as
        // well; preserve that oddity for clients without acknowledgements.
        .then((vcf) => response(callback, "save-vcf", success(vcf, "Successfully retrieved VCF")))
        .catch((error: Error) => response(callback, "error", failure(500, error.message, "Server Error", error.message)));
    });
    socket.on("get-contacts-from-vcf", (_params, callback) => {
      void this.loadContactsVcf()
        .then((vcf) => response(callback, "contacts-from-vcf", success(vcf ?? "")))
        .catch((error: Error) => response(
          callback,
          "contacts-from-vcf",
          failure(500, error.message, "Server Error", error.message),
        ));
    });
    socket.on("check-for-server-update", (_params, callback) => response(
      callback,
      // BlueBubbles 1.9.9 itself emits this response on save-vcf.
      "save-vcf",
      success({ available: false, currentVersion: IBLUE_VERSION, latestVersion: IBLUE_VERSION }),
    ));

    const unsupportedSocket = (event: string): void => {
      socket.on(event, (_params, callback) => response(
        callback,
        "error",
        unsupported(`Socket.IO ${event}`),
      ));
    };
    for (const event of [
      "add-fcm-device",
      "change-proxy-service",
      "restart-messages-app",
      "restart-private-api",
    ]) unsupportedSocket(event);
    socket.on("get-chats", (params, callback) => {
      const body = asRecord(params);
      const result = this.service.store.queryChats({
        offset: numberValue(body.offset, 0),
        limit: numberValue(body.limit, 1000),
        withLastMessage: Boolean(body.withLastMessage),
      });
      response(callback, "chats", success(result.chats));
    });
    socket.on("get-chat", (params, callback) => {
      const body = asRecord(params);
      const chat = typeof body.chatGuid === "string" ? this.service.store.getChat(body.chatGuid, true, true) : undefined;
      response(callback, chat ? "chat" : "error", chat ? success(chat) : notFound("Chat does not exist!"));
    });
    socket.on("get-chat-messages", (params, callback) => {
      const body = asRecord(params);
      const result = this.service.queryMessages({
        ...(typeof body.identifier === "string"
          ? { chatGuid: body.identifier }
          : typeof body.chatGuid === "string"
            ? { chatGuid: body.chatGuid }
            : {}),
        offset: numberValue(body.offset, 0),
        limit: numberValue(body.limit, 100),
        ...(body.after === undefined ? {} : { after: numberValue(body.after, 0) }),
        ...(body.before === undefined ? {} : { before: numberValue(body.before, 0) }),
        sort: body.sort === "ASC" ? "ASC" : "DESC",
      });
      response(callback, "chat-messages", success(result.messages));
    });
    socket.on("get-messages", (params, callback) => {
      const body = asRecord(params);
      const result = this.service.queryMessages({
        ...(typeof body.chatGuid === "string" ? { chatGuid: body.chatGuid } : {}),
        offset: numberValue(body.offset, 0),
        limit: numberValue(body.limit, 100),
        ...(body.after === undefined ? {} : { after: numberValue(body.after, 0) }),
        ...(body.before === undefined ? {} : { before: numberValue(body.before, 0) }),
        sort: body.sort === "DESC" ? "DESC" : "ASC",
      });
      response(callback, "messages", success(result.messages));
    });
    socket.on("get-last-chat-message", (params, callback) => {
      const body = asRecord(params);
      const identifier = typeof body.identifier === "string" ? body.identifier : undefined;
      if (!identifier) {
        return response(
          callback,
          "error",
          failure(400, "No chat identifier provided", "Validation Error", "No chat identifier provided"),
        );
      }
      const result = this.service.queryMessages({ chatGuid: identifier, limit: 1 });
      response(callback, "last-chat-message", success(result.messages[0] ?? null));
    });
    socket.on("get-participants", (params, callback) => {
      const body = asRecord(params);
      const identifier = typeof body.identifier === "string" ? body.identifier : undefined;
      const chat = identifier ? this.service.store.getChat(identifier, true) : undefined;
      response(
        callback,
        chat ? "participants" : "error",
        chat
          ? success(chat.participants ?? [])
          : failure(400, "Chat does not exist", "Database Error", "Chat does not exist"),
      );
    });
    socket.on("get-attachment", (params, callback) => {
      const body = asRecord(params);
      const identifier = typeof body.identifier === "string" ? body.identifier : undefined;
      const attachment = identifier ? this.service.store.getAttachment(identifier) : undefined;
      if (!attachment) {
        return response(
          callback,
          "error",
          failure(400, "Attachment does not exist", "Database Error", "Attachment does not exist"),
        );
      }
      void (async () => {
        const data = attachment.path ? (await readFile(attachment.path)).toString("base64") : null;
        response(callback, "attachment", success({ ...attachment.response, data }));
      })().catch((error: Error) =>
        response(callback, "error", failure(500, error.message, "Server Error", error.message)),
      );
    });
    socket.on("get-attachment-chunk", (params, callback) => {
      const body = asRecord(params);
      const identifier = typeof body.identifier === "string" ? body.identifier : undefined;
      const attachment = identifier ? this.service.store.getAttachment(identifier) : undefined;
      if (!attachment?.path) {
        return response(
          callback,
          "error",
          failure(
            400,
            "Attachment not downloaded on server",
            "Database Error",
            "Attachment not downloaded on server",
          ),
        );
      }
      void (async () => {
        const start = Math.max(numberValue(body.start, 0), 0);
        const size = Math.max(numberValue(body.chunkSize, 1024), 1);
        const file = await readFile(attachment.path!);
        let chunk = file.subarray(start, start + size);
        if (body.compress === true) chunk = deflateSync(chunk);
        response(callback, "attachment-chunk", success(chunk.toString("base64")));
      })().catch((error: Error) =>
        response(callback, "error", failure(500, error.message, "Server Error", error.message)),
      );
    });
    socket.on("send-message", (params, callback) => {
      const body = asRecord(params);
      void this.sendSocketMessage(body)
        .then((message) => response(callback, "message-sent", success(message, "Message sent!")))
        .catch((error: Error) =>
          response(callback, "send-message-error", failure(500, "Message Send Error", "iMessage Error", error.message)),
        );
    });
    socket.on("send-message-chunk", (params, callback) => {
      void this.sendSocketChunk(socket.id, uploads, asRecord(params))
        .then(({ channel, payload }) => response(callback, channel, payload))
        .catch((error: Error) =>
          response(callback, "send-message-error", failure(500, "Message Send Error", "iMessage Error", error.message)),
        );
    });
    socket.on("start-chat", (params, callback) => {
      const body = asRecord(params);
      const raw = typeof body.participants === "string"
        ? [body.participants]
        : Array.isArray(body.participants)
          ? body.participants.map(String)
          : [];
      if (raw.length === 0) {
        return response(
          callback,
          "error",
          failure(400, "No participants specified", "Validation Error", "No participants specified"),
        );
      }
      void (async () => {
        const chatGuid = this.service.createChat(raw);
        if (typeof body.message === "string" && body.message.length > 0) {
          const effectId = outboundEffectId(body.effectId, body.flair);
          await this.service.sendText({
            chatGuid,
            message: body.message,
            ...(typeof body.tempGuid === "string" ? { tempGuid: body.tempGuid } : {}),
            ...(effectId ? { effectId } : {}),
          });
        }
        const chat = this.service.store.getChat(chatGuid, true, true);
        response(callback, "chat-started", success(chat, "Successfully started chat!"));
      })().catch((error: Error) =>
        response(callback, "start-chat-failed", failure(500, "Failed to start chat", "iMessage Error", error.message)),
      );
    });
    socket.on("rename-group", (params, callback) => {
      const body = asRecord(params);
      const identifier = typeof body.identifier === "string" ? body.identifier : undefined;
      const newName = typeof body.newName === "string" ? body.newName : undefined;
      if (!identifier) {
        return response(callback, "error", failure(400, "No chat identifier provided", "Validation Error", "No chat identifier provided"));
      }
      if (!newName) {
        return response(callback, "error", failure(400, "No new group name provided", "Validation Error", "No new group name provided"));
      }
      void this.service.renameGroup(identifier, newName)
        .then((chat) => response(callback, "group-renamed", success(chat)))
        .catch((error: Error) =>
          response(callback, "rename-group-error", failure(500, "Failed to rename group", "iMessage Error", error.message)),
        );
    });
    const socketParticipant = (action: "add" | "remove") => (params: unknown, callback: unknown): void => {
      const body = asRecord(params);
      const identifier = typeof body.identifier === "string" ? body.identifier : undefined;
      const address = typeof body.address === "string" ? body.address : undefined;
      if (!identifier) {
        response(callback, "error", failure(400, "No chat identifier provided", "Validation Error", "No chat identifier provided"));
        return;
      }
      if (!address) {
        response(callback, "error", failure(400, "No participant address specified", "Validation Error", "No participant address specified"));
        return;
      }
      void this.service.changeGroupParticipant(identifier, address, action)
        .then((chat) => response(callback, action === "add" ? "participant-added" : "participant-removed", success(chat)))
        .catch((error: Error) => response(
          callback,
          `${action}-participant-error`,
          failure(500, `Failed to ${action} participant`, "iMessage Error", error.message),
        ));
    };
    socket.on("add-participant", socketParticipant("add"));
    socket.on("remove-participant", socketParticipant("remove"));
    socket.on("send-reaction", (params, callback) => {
      const body = asRecord(params);
      const tapback = typeof body.tapback === "string" ? body.tapback as IBlueReactionRequest : undefined;
      const allowed: IBlueReactionRequest[] = [
        "love", "like", "dislike", "laugh", "emphasize", "question",
        "-love", "-like", "-dislike", "-laugh", "-emphasize", "-question",
        "emoji", "-emoji",
      ];
      if (!tapback || !allowed.includes(tapback)) {
        return response(
          callback,
          "error",
          failure(400, "Invalid tapback descriptor provided!", "Validation Error", "Invalid tapback descriptor provided!"),
        );
      }
      void (async () => {
        const emoji = emojiForReaction(tapback, body.emoji);
        return this.service.sendReaction({
          chatGuid: requiredString(body, "chatGuid"),
          selectedMessageGuid: requiredString(body, "actionMessageGuid"),
          reaction: tapback,
          ...(emoji ? { emoji } : {}),
          ...(body.partIndex === undefined ? {} : { partIndex: numberValue(body.partIndex, 0) }),
        });
      })()
        .then((message) => response(callback, "tapback-sent", success(message, "Successfully sent reaction!")))
        .catch((error: Error) =>
          response(callback, "send-tapback-error", failure(500, "Reaction Send Error", "iMessage Error", error.message)),
        );
    });
    const typing = (active: boolean, successChannel: string, errorChannel: string) =>
      (params: unknown, callback: unknown): void => {
        const body = asRecord(params);
        let chatGuid: string;
        try {
          chatGuid = requiredString(body, "chatGuid");
        } catch (error) {
          response(callback, "error", failure(400, "No chat GUID provided!", "Validation Error", String(error)));
          return;
        }
        void this.service.setTyping(chatGuid, active)
          .then(() => response(callback, successChannel, success(null)))
          .catch((error: Error) =>
            response(callback, errorChannel, failure(500, "Failed to update typing status", "iMessage Error", error.message)),
          );
      };
    socket.on("started-typing", typing(true, "started-typing-sent", "started-typing-error"));
    socket.on("stopped-typing", typing(false, "stopped-typing-sent", "stopped-typing-error"));
    socket.on("update-typing-status", typing(true, "update-typing-status-sent", "update-typing-status-error"));
    socket.on("mark-chat-read", (params, callback) => {
      const body = asRecord(params);
      void (async () => this.service.markChatRead(requiredString(body, "chatGuid")))()
        .then(() => response(callback, "mark-chat-read-sent", success(null)))
        .catch((error: Error) =>
          response(callback, "mark-chat-read-error", failure(500, "Failed to mark chat read", "iMessage Error", error.message)),
        );
    });
    socket.on("open-chat", (params, callback) => {
      const body = asRecord(params);
      void (async () => this.service.markChatRead(requiredString(body, "chatGuid")))()
        .then(() => response(callback, "chat-opened", success(null)))
        .catch((error: Error) => response(callback, "error", failure(500, "Failed to open chat", "iMessage Error", error.message)));
    });
    socket.on("toggle-chat-read-status", (params, callback) => {
      const body = asRecord(params);
      try {
        const chatGuid = requiredString(body, "chatGuid");
        const status = body.status === undefined ? true : Boolean(body.status);
        this.service.dispatch("chat-read-status-changed", { chatGuid, status });
        response(callback, "chat-read-status-changed", success(null));
      } catch (error) {
        response(callback, "error", failure(400, "No chat GUID provided!", "Validation Error", String(error)));
      }
    });
    socket.on("disconnect", () => {
      for (const upload of uploads.values()) void rm(upload.directory, { recursive: true, force: true });
      uploads.clear();
      const sessionIds = new Set(
        [...(this.#faceTimeSocketSubscriptions.get(socket.id)?.values() ?? [])]
          .map((subscription) => subscription.sessionId),
      );
      for (const subscription of this.#faceTimeSocketSubscriptions.get(socket.id)?.values() ?? []) {
        clearTimeout(subscription.timer);
      }
      this.#faceTimeSocketSubscriptions.delete(socket.id);
      for (const sessionId of sessionIds) {
        void this.refreshNativeFaceTimeStream(sessionId).catch((error) => this.app.log.error(error));
      }
      for (const [callId, ownerSocketId] of [...this.#faceTimeLiveAudioOwners]) {
        if (ownerSocketId !== socket.id) continue;
        this.#faceTimeLiveAudioOwners.delete(callId);
        void this.#faceTimeMedia?.finishLiveAudio?.(callId).catch((error) =>
          this.app.log.error(error));
      }
      for (const [sessionId, owner] of [...this.#faceTimeIncomingLiveOwners]) {
        if (owner.socketId !== socket.id) continue;
        this.#faceTimeIncomingLiveOwners.delete(sessionId);
        void (async () => {
          if (owner.audio) {
            await this.service.finishNativeFaceTimeLiveAudioStream(sessionId).catch((error) =>
              this.app.log.error(error));
          }
          if (owner.video) {
            await this.service.finishNativeFaceTimeLiveVideoStream(sessionId).catch((error) =>
              this.app.log.error(error));
          }
          await this.service.leaveFaceTimeSession(sessionId).catch((error) =>
            this.app.log.error(error));
          await this.revokeFaceTimeSubscriptions(sessionId);
        })();
      }
    });
  }

  private async sendSocketChunk(
    socketId: string,
    uploads: Map<string, SocketUpload>,
    body: Record<string, unknown>,
  ): Promise<{ channel: string; payload: BlueBubblesResponse }> {
    const chatGuid = typeof body.guid === "string" ? body.guid : requiredString(body, "chatGuid");
    const tempGuid = requiredString(body, "tempGuid");
    const attachmentGuid = typeof body.attachmentGuid === "string" ? body.attachmentGuid : undefined;
    const hasMore = body.hasMore === true;
    let upload: SocketUpload | undefined;

    if (attachmentGuid) {
      const key = `${socketId}:${attachmentGuid}`;
      upload = uploads.get(key);
      if (!upload) {
        const directory = await mkdtemp(join(tmpdir(), "iblue-socket-chunks-"));
        upload = { directory, path: join(directory, "attachment.part"), chatGuid, tempGuid, nextOffset: 0 };
        uploads.set(key, upload);
      }
      if (upload.chatGuid !== chatGuid || upload.tempGuid !== tempGuid) {
        throw new Error("attachment GUID is already associated with another message");
      }
      const start = numberValue(body.attachmentChunkStart, upload.nextOffset);
      if (start !== upload.nextOffset) {
        throw new Error(`attachment chunk offset ${start} does not match expected offset ${upload.nextOffset}`);
      }
      const encoded = typeof body.attachmentData === "string" ? body.attachmentData : "";
      const chunk = Buffer.from(encoded, "base64");
      if (chunk.length > 100 * 1024 * 1024) throw new Error("attachment chunk exceeds 100 MiB");
      if (upload.nextOffset + chunk.length > 1024 * 1024 * 1024) throw new Error("attachment exceeds 1 GiB");
      await writeFile(upload.path, chunk, { flag: upload.nextOffset === 0 ? "w" : "a", mode: 0o600 });
      upload.nextOffset += chunk.length;
    }

    if (hasMore) return { channel: "message-chunk-saved", payload: success(null) };
    if (!attachmentGuid && typeof body.message !== "string") throw new Error("No message or attachment provided");

    try {
      const effectId = outboundEffectId(body.effectId, body.flair);
      if (attachmentGuid) {
        if (!upload) throw new Error("attachment upload state is missing");
        const filename = typeof body.attachmentName === "string" ? basename(body.attachmentName) : undefined;
        if (!filename) throw new Error("No attachment name provided");
        const mimeType = mimeForFilename(filename);
        await this.service.sendAttachment({
          chatGuid,
          path: upload.path,
          filename,
          mimeType,
          utiType: utiForMime(mimeType),
          tempGuid: attachmentGuid,
          ...(effectId ? { effectId } : {}),
        });
      }
      if (typeof body.message === "string" && body.message.length > 0) {
        await this.service.sendText({
          chatGuid,
          message: body.message,
          tempGuid,
          ...(effectId ? { effectId } : {}),
        });
      }
      return { channel: "message-sent", payload: success(null) };
    } finally {
      if (attachmentGuid && upload) {
        uploads.delete(`${socketId}:${attachmentGuid}`);
        await rm(upload.directory, { recursive: true, force: true });
      }
    }
  }

  private async sendSocketMessage(body: Record<string, unknown>) {
    const chatGuid = typeof body.guid === "string"
      ? body.guid
      : requiredString(body, "chatGuid");
    const effectId = outboundEffectId(body.effectId, body.flair);
    let sent;
    if (typeof body.attachment === "string") {
      const directory = await mkdtemp(join(tmpdir(), "iblue-socket-upload-"));
      const filename = typeof body.attachmentName === "string" ? basename(body.attachmentName) : "attachment";
      const path = join(directory, filename);
      try {
        await writeFile(path, Buffer.from(body.attachment, "base64"), { mode: 0o600 });
        const mimeType = mimeForFilename(filename);
        sent = await this.service.sendAttachment({
          chatGuid,
          path,
          filename,
          mimeType,
          utiType: utiForMime(mimeType),
          ...(typeof body.tempGuid === "string" ? { tempGuid: body.tempGuid } : {}),
          ...(effectId ? { effectId } : {}),
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    if (typeof body.message === "string") {
      const attributedBody = outboundAttributedBody(body, body.message);
      sent = await this.service.sendText({
        chatGuid,
        message: body.message,
        ...(typeof body.tempGuid === "string" ? { tempGuid: body.tempGuid } : {}),
        ...(effectId ? { effectId } : {}),
        ...(attributedBody ? { attributedBody } : {}),
      });
    }
    if (!sent) throw new Error("No message or attachment provided");
    return sent;
  }

  private serverMetadata(): Record<string, unknown> {
    const runtimePlatform = platform();
    const runtimeRelease = release();
    let osVersion = "15.0";
    if (runtimePlatform === "darwin") {
      try {
        const detected = execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
        // The official BlueBubbles client indexes the first two dot-separated
        // components and expects both to be integers.
        if (/^\d+\.\d+(?:\.\d+)?$/.test(detected)) osVersion = detected;
      } catch {
        // Keep the parse-safe compatibility value. The direct IDS engine does
        // not inherit feature support from the host operating system.
      }
    }
    return {
      computer_id: derivePublicComputerId(this.service.profile, this.service.snapshot?.deviceId),
      os_version: osVersion,
      server_version: BLUEBUBBLES_COMPAT_VERSION,
      private_api: true,
      helper_connected: true,
      proxy_service: "Manual",
      detected_icloud: this.service.snapshot?.accountUsername ?? "",
      // BlueBubbles obtains this from chat.account_login and removes the IDS
      // transport prefix before returning it. Keep the public metadata shape
      // consistent even though iBlue retains canonical mailto:/tel: handles
      // internally for directory lookups.
      detected_imessage: this.service.handles[0] ? stripTransport(this.service.handles[0]) : "",
      // BlueBubbles reports the SNTP clock *offset* in seconds here, not an
      // epoch timestamp. iBlue does not invoke `sntp time.apple.com`, so the
      // honest upstream-compatible absence value is null.
      macos_time_sync: null,
      local_ipv4s: localAddresses("IPv4"),
      local_ipv6s: localAddresses("IPv6"),
      iBlue: {
        version: IBLUE_VERSION,
        profile: this.service.profile,
        transport: "direct-ids",
        idsMode: this.service.snapshot?.idsMode ?? "unknown",
        runtimePlatform,
        runtimeRelease,
        blueBubblesCompatibility: BLUEBUBBLES_COMPAT_VERSION,
        blueBubblesCommit: BLUEBUBBLES_COMPAT_COMMIT,
        extensions: {
          contacts: "/api/v1/iblue/contact",
          contactCards: "/api/v1/iblue/contact-card",
          icloudContactsSync: "/api/v1/iblue/contact/icloud/sync",
          focus: "/api/v1/handle/:guid/focus",
          focusSync: "/api/v1/iblue/focus/sync",
          messagesInICloud: "/api/v1/iblue/cloud/messages/messages/sync",
          sharedLocations: "/api/v1/iblue/location/query",
          liveSharedLocations: "/api/v1/iblue/location/live",
          messageFlair: "/api/v1/iblue/message/flair",
          attributedText: "/api/v1/iblue/message/text-effects",
          messageReceipts: "/api/v1/iblue/message/:guid/receipts",
          messageReceiptEvent: "iblue-message-receipt",
          stickerReactions: "/api/v1/iblue/message/sticker",
          polls: "/api/v1/iblue/poll/:messageGuid",
          richLinks: "message.iBlue.richLink",
          messageComponents: "/api/v1/iblue/message/component",
          conversationBackgrounds: "/api/v1/iblue/chat/:guid/background",
          conversationBackgroundPresets: "/api/v1/iblue/background/presets",
          icloudShares: "/api/v1/iblue/icloud-share/:messageGuid",
          icloudShareCreate: "/api/v1/iblue/icloud-share/create",
          faceTimeSessions: "/api/v1/iblue/facetime/session",
          faceTimeCapabilities: "/api/v1/iblue/facetime/capabilities",
          faceTimeCalls: "/api/v1/iblue/facetime/call",
          faceTimeCallEvent: "ft-call-status-changed",
        },
      },
    };
  }

  private messageCount(query: Query, flags: { isFromMe?: boolean; updated?: boolean } = {}): number {
    return this.service.store.countMessages({
      ...(query.chatGuid ? { chatGuid: query.chatGuid } : {}),
      ...(query.after === undefined ? {} : { after: numberValue(query.after, 0) }),
      ...(query.before === undefined ? {} : { before: numberValue(query.before, 0) }),
      ...(query.minRowId === undefined ? {} : { minRowId: numberValue(query.minRowId, 0) }),
      ...(query.maxRowId === undefined ? {} : { maxRowId: numberValue(query.maxRowId, 0) }),
      ...flags,
    });
  }

  private async sendAttachmentDownload(guid: string, reply: FastifyReply): Promise<unknown> {
    const attachment = this.service.store.getAttachment(guid);
    if (!attachment) return reply.code(404).send(notFound("Attachment does not exist!"));
    if (!attachment.path) return reply.code(404).send(notFound("Attachment has not been downloaded!"));
    reply.header("content-type", attachment.response.mimeType || "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${basename(attachment.response.transferName)}"`);
    return reply.send(await readFile(attachment.path));
  }

  private contactsVcfPath(): string {
    return join(this.service.store.attachmentRoot, ".contacts", "AddressBook.vcf");
  }

  private async saveContactsVcf(vcf: string): Promise<number> {
    const path = this.contactsVcfPath();
    await mkdir(join(this.service.store.attachmentRoot, ".contacts"), { recursive: true, mode: 0o700 });
    await writeFile(path, vcf, { mode: 0o600 });
    return this.service.store.replaceProfileVcfContacts(parseVCardContacts(vcf));
  }

  private async loadContactsVcf(): Promise<string | null> {
    try {
      return await readFile(this.contactsVcfPath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private multipartUploadRoot(): string {
    return join(this.service.store.attachmentRoot, ".uploads");
  }

  private async tryFaceTimeAutoAnswer(data: unknown): Promise<void> {
    const arm = this.#faceTimeAutoAnswer;
    if (!arm || arm.state !== "armed") return;
    if (arm.expiresAt <= Date.now()) {
      await this.clearFaceTimeAutoAnswer(arm);
      return;
    }
    const event = asRecord(data);
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : undefined;
    if (!sessionId) return;
    let incoming = isFaceTimeIncomingSession(data) ? data : undefined;
    incoming ??= (await this.service.listIncomingFaceTimeSessions())
      .find((session) => session.sessionId.toUpperCase() === sessionId.toUpperCase());
    if (!incoming || incoming.state !== "ringing" || incoming.mode !== arm.mode) return;
    if (arm.caller) {
      const remoteAddresses = [incoming.caller, ...incoming.participants]
        .filter((value): value is string => Boolean(value))
        .map(normalizeFaceTimeAddress);
      if (!remoteAddresses.includes(arm.caller)) return;
    }
    arm.state = "answering";
    clearTimeout(arm.timer);
    try {
      await this.#faceTimeMedia!.answerIncoming!({
        sessionId: incoming.sessionId,
        displayName: arm.displayName,
        sourcePath: arm.sourcePath,
        maxDurationSeconds: arm.maxDurationSeconds,
      });
    } finally {
      await this.clearFaceTimeAutoAnswer(arm);
    }
  }

  private async clearFaceTimeAutoAnswer(arm = this.#faceTimeAutoAnswer): Promise<void> {
    if (!arm) return;
    if (this.#faceTimeAutoAnswer === arm) this.#faceTimeAutoAnswer = undefined;
    clearTimeout(arm.timer);
    await rm(arm.directory, { recursive: true, force: true });
  }

  private async cleanupStaleMultipartUploads(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
    const root = this.multipartUploadRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const entries = await readdir(root, { withFileTypes: true });
    const cutoff = Date.now() - maxAgeMs;
    await Promise.all(entries.flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      const directory = join(root, entry.name);
      return [stat(directory).then(async (info) => {
        if (info.mtimeMs < cutoff) await rm(directory, { recursive: true, force: true });
      }).catch(() => undefined)];
    }));
  }

  private resolveMultipartUpload(value: string): { path: string; directory: string } {
    const parts = value.split("/");
    if (parts.length !== 2 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parts[0]!)) {
      throw new RequestError(400, `Attachment '${value}' does not exist`, "VALIDATION_ERROR");
    }
    const name = safeAttachmentName(parts[1]!);
    if (name !== parts[1]) {
      throw new RequestError(400, `Attachment '${value}' does not exist`, "VALIDATION_ERROR");
    }
    const directory = join(this.multipartUploadRoot(), parts[0]!);
    return { directory, path: join(directory, name) };
  }
}

class RequestError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 415 | 500 | 501 | 502 | 504,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

function iCloudShareRequestError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  if (error instanceof ICloudShareError) {
    return new RequestError(error.status, error.message, "ICLOUD_SHARE_ERROR");
  }
  const message = error instanceof Error ? error.message : String(error);
  return new RequestError(502, `Could not resolve iCloud Photos share: ${message}`, "ICLOUD_SHARE_ERROR");
}

async function resolveFreshICloudShare(resolver: ICloudShareResolver, url: string) {
  let lastError: ICloudShareError | undefined;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await resolver.resolve(url, true);
    } catch (error) {
      if (!(error instanceof ICloudShareError) || error.status !== 404) throw error;
      lastError = error;
      if (attempt < 29) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError ?? new ICloudShareError("iCloud Photos share did not become public", 504);
}

function iCloudShareVariant(value: string): IBlueICloudShareVariantName | undefined {
  return value === "original" || value === "medium" || value === "thumbnail" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeFaceTimeAddress(value: string): string {
  const trimmed = value.trim();
  return (trimmed.startsWith("tel:") || trimmed.startsWith("mailto:")
    ? trimmed
    : toTransportAddress(trimmed)).toLowerCase();
}

function isFaceTimeIncomingSession(value: unknown): value is FaceTimeIncomingSession {
  const record = asRecord(value);
  return typeof record.sessionId === "string"
    && (record.state === "ringing"
      || record.state === "active"
      || record.state === "answered-elsewhere"
      || record.state === "declined")
    && (record.mode === "audio" || record.mode === "video")
    && Array.isArray(record.participants);
}

function publicFaceTimeAutoAnswerArm(
  arm: FaceTimeAutoAnswerArm,
): PublicFaceTimeAutoAnswerArm {
  return {
    id: arm.id,
    filename: arm.filename,
    mimeType: arm.mimeType,
    size: arm.size,
    mode: arm.mode,
    ...(arm.caller ? { caller: arm.caller } : {}),
    displayName: arm.displayName,
    maxDurationSeconds: arm.maxDurationSeconds,
    createdAt: arm.createdAt,
    expiresAt: arm.expiresAt,
    state: arm.state,
  };
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RequestError(400, `${key} is required`, "VALIDATION_ERROR");
  }
  return value;
}

function contactCardInput(body: Record<string, unknown>): IBlueContactCardInput {
  const displayName = requiredString(body, "displayName").trim();
  if (displayName.length > 512) {
    throw new RequestError(400, "displayName is too long", "VALIDATION_ERROR");
  }
  const optional = (key: string): string | undefined => {
    const value = body[key];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") {
      throw new RequestError(400, `${key} must be a string`, "VALIDATION_ERROR");
    }
    return value.trim();
  };
  const fields = (key: string): IBlueContactCardField[] | undefined => {
    const value = body[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 32) {
      throw new RequestError(400, `${key} must be an array with at most 32 entries`, "VALIDATION_ERROR");
    }
    return value.map((entry, index) => {
      const field = asRecord(entry);
      const fieldValue = requiredString(field, "value").trim();
      const types = field.types === undefined
        ? undefined
        : Array.isArray(field.types) && field.types.every((type) => typeof type === "string")
          ? field.types.map((type) => type.trim()).filter(Boolean)
          : (() => {
            throw new RequestError(400, `${key}[${index}].types must be an array of strings`, "VALIDATION_ERROR");
          })();
      return {
        value: fieldValue,
        ...(typeof field.label === "string" && field.label.trim() ? { label: field.label.trim() } : {}),
        ...(types?.length ? { types } : {}),
        ...(field.preferred === true ? { preferred: true } : {}),
      };
    });
  };
  const socialProfiles = fields("socialProfiles")?.map((field, index): IBlueContactCardSocialProfile => {
    const source = asRecord((body.socialProfiles as unknown[])[index]);
    return {
      ...field,
      ...(typeof source.service === "string" && source.service.trim()
        ? { service: source.service.trim() }
        : {}),
      ...(typeof source.userId === "string" && source.userId.trim()
        ? { userId: source.userId.trim() }
        : {}),
    };
  });
  let addresses: IBlueContactCardAddress[] | undefined;
  if (body.addresses !== undefined) {
    if (!Array.isArray(body.addresses) || body.addresses.length > 32) {
      throw new RequestError(400, "addresses must be an array with at most 32 entries", "VALIDATION_ERROR");
    }
    const addressKeys = ["label", "extended", "street", "city", "region", "postalCode", "country"] as const;
    addresses = body.addresses.map((entry, index) => {
      const source = asRecord(entry);
      const address: IBlueContactCardAddress = {};
      for (const key of addressKeys) {
        if (source[key] === undefined || source[key] === "") continue;
        if (typeof source[key] !== "string") {
          throw new RequestError(400, `addresses[${index}].${key} must be a string`, "VALIDATION_ERROR");
        }
        address[key] = source[key].trim();
      }
      if (source.preferred === true) address.preferred = true;
      return address;
    });
  }
  const firstName = optional("firstName");
  const middleName = optional("middleName");
  const lastName = optional("lastName");
  const prefix = optional("prefix");
  const suffix = optional("suffix");
  const nickname = optional("nickname");
  const organization = optional("organization");
  const department = optional("department");
  const title = optional("title");
  const birthday = optional("birthday");
  const note = optional("note");
  const phones = fields("phones");
  const emails = fields("emails");
  const urls = fields("urls");
  return {
    displayName,
    ...(firstName ? { firstName } : {}),
    ...(middleName ? { middleName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
    ...(nickname ? { nickname } : {}),
    ...(organization ? { organization } : {}),
    ...(department ? { department } : {}),
    ...(title ? { title } : {}),
    ...(birthday ? { birthday } : {}),
    ...(note ? { note } : {}),
    ...(phones?.length ? { phones } : {}),
    ...(emails?.length ? { emails } : {}),
    ...(urls?.length ? { urls } : {}),
    ...(addresses?.length ? { addresses } : {}),
    ...(socialProfiles?.length ? { socialProfiles } : {}),
  };
}

function contactPhotoMime(data: Buffer): "image/jpeg" | "image/png" {
  if (data.length > 5 * 1024 * 1024) {
    throw new RequestError(415, "Contact photo must be at most 5 MB", "VALIDATION_ERROR");
  }
  const mimeType = detectImageMime(data);
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
    throw new RequestError(415, "Contact photo must be JPEG or PNG", "VALIDATION_ERROR");
  }
  return mimeType;
}

function outboundAttributedBody(body: Record<string, unknown>, text: string): string | undefined {
  const attributedBody = typeof body.attributedBody === "string" ? body.attributedBody : undefined;
  if (body.textRuns === undefined) return attributedBody;
  if (attributedBody !== undefined) {
    throw new RequestError(400, "Use either 'attributedBody' or 'textRuns', not both", "VALIDATION_ERROR");
  }
  try {
    return htmlFromTextRuns(text, parseOutboundTextRuns(body.textRuns, text));
  } catch (error) {
    throw new RequestError(
      400,
      error instanceof Error ? error.message : String(error),
      "VALIDATION_ERROR",
    );
  }
}

function emojiForReaction(reaction: IBlueReactionRequest, value: unknown): string | undefined {
  if (reaction !== "emoji" && reaction !== "-emoji") {
    if (value !== undefined) {
      throw new RequestError(400, "'emoji' is only valid with an emoji reaction", "VALIDATION_ERROR");
    }
    return undefined;
  }
  try {
    assertSingleEmoji(value);
    return value;
  } catch (error) {
    throw new RequestError(
      400,
      error instanceof Error ? error.message : String(error),
      "VALIDATION_ERROR",
    );
  }
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function outboundEffectId(effectIdValue: unknown, flairValue: unknown): string | undefined {
  const effectId = typeof effectIdValue === "string" ? effectIdValue.trim() : undefined;
  if (flairValue !== undefined && typeof flairValue !== "string") {
    throw new RequestError(400, "flair must be a string", "VALIDATION_ERROR");
  }
  const flair = typeof flairValue === "string" ? flairValue.trim() : undefined;
  if (!flair) return effectId || undefined;
  const resolved = effectIdForMessageFlair(flair);
  if (!resolved) {
    throw new RequestError(
      400,
      `Unknown message flair '${flair}'. Use one of: ${MESSAGE_FLAIRS.map((item) => item.name).join(", ")}`,
      "VALIDATION_ERROR",
    );
  }
  if (effectId && effectId !== resolved) {
    throw new RequestError(400, "effectId and flair select different message effects", "VALIDATION_ERROR");
  }
  return effectId || resolved;
}

function scheduledMessageDraft(value: unknown): ScheduledMessageDraft {
  const body = asRecord(value);
  if (body.type !== "send-message") {
    throw new RequestError(400, "type must be send-message", "VALIDATION_ERROR");
  }
  const payload = asRecord(body.payload);
  const chatGuid = requiredString(payload, "chatGuid");
  const message = requiredString(payload, "message");
  const method = requiredString(payload, "method");
  if (typeof body.scheduledFor !== "number" || !Number.isFinite(body.scheduledFor)) {
    throw new RequestError(400, "scheduledFor must be a number", "VALIDATION_ERROR");
  }
  if (body.scheduledFor < Date.now()) {
    throw new RequestError(400, "scheduledFor must be in the future", "VALIDATION_ERROR");
  }

  const rawSchedule = asRecord(body.schedule);
  let schedule: ScheduledMessageDraft["schedule"];
  if (rawSchedule.type === "once") {
    schedule = { type: "once" };
  } else if (rawSchedule.type === "recurring") {
    const intervalTypes: BlueBubblesScheduleInterval[] = ["hourly", "daily", "weekly", "monthly", "yearly"];
    if (typeof rawSchedule.interval !== "number" || !Number.isFinite(rawSchedule.interval) || rawSchedule.interval < 1) {
      throw new RequestError(400, "Schedule interval must be a number greater than 0", "VALIDATION_ERROR");
    }
    if (!intervalTypes.includes(rawSchedule.intervalType as BlueBubblesScheduleInterval)) {
      throw new RequestError(
        400,
        `Schedule intervalType must be one of: ${intervalTypes.join(", ")}`,
        "VALIDATION_ERROR",
      );
    }
    schedule = {
      type: "recurring",
      interval: rawSchedule.interval,
      intervalType: rawSchedule.intervalType as BlueBubblesScheduleInterval,
    };
  } else {
    throw new RequestError(400, "Schedule Type is required", "VALIDATION_ERROR");
  }

  const partIndex = payload.partIndex === undefined ? undefined : numberValue(payload.partIndex, Number.NaN);
  if (partIndex !== undefined && (!Number.isInteger(partIndex) || partIndex < 0)) {
    throw new RequestError(400, "partIndex must be a non-negative integer", "VALIDATION_ERROR");
  }
  const effectId = outboundEffectId(payload.effectId, payload.flair);
  const attributedBody = outboundAttributedBody(payload, message);
  return {
    payload: {
      chatGuid,
      message,
      method,
      ...(typeof payload.selectedMessageGuid === "string"
        ? { selectedMessageGuid: payload.selectedMessageGuid }
        : {}),
      ...(effectId ? { effectId } : {}),
      ...(typeof payload.subject === "string" ? { subject: payload.subject } : {}),
      ...(attributedBody ? { attributedBody } : {}),
      ...(partIndex === undefined ? {} : { partIndex }),
    },
    scheduledFor: new Date(body.scheduledFor).toISOString(),
    schedule,
  };
}

function statisticsOnly(value: string | undefined, defaults: string[]): Set<string> {
  const values = value ? value.split(",") : defaults;
  return new Set(values.map((item) => {
    const normalized = item.trim().toLowerCase();
    return normalized.endsWith("s") ? normalized.slice(0, -1) : normalized;
  }));
}

function rowIdQueryBounds(value: unknown): Pick<import("./store.js").QueryOptions, "afterRowId" | "throughRowId"> {
  if (!Array.isArray(value)) return {};
  const bounds: { afterRowId?: number; throughRowId?: number } = {};
  for (const item of value) {
    const condition = asRecord(item);
    if (typeof condition.statement !== "string") continue;
    const statement = condition.statement.replace(/\s+/g, "").toLowerCase();
    const args = asRecord(condition.args);
    if (/^message\.(?:rowid|originalrowid)>:startrowid$/.test(statement)) {
      const parsed = numberValue(args.startRowId, Number.NaN);
      if (Number.isInteger(parsed) && parsed >= 0) bounds.afterRowId = parsed;
    } else if (/^message\.(?:rowid|originalrowid)<=:endrowid$/.test(statement)) {
      const parsed = numberValue(args.endRowId, Number.NaN);
      if (Number.isInteger(parsed) && parsed >= 0) bounds.throughRowId = parsed;
    }
  }
  return bounds;
}

function queryOptions(query: Query, chatGuid?: string) {
  return {
    ...(chatGuid ? { chatGuid } : {}),
    offset: numberValue(query.offset, 0),
    limit: numberValue(query.limit, 100),
    ...(query.before === undefined ? {} : { before: numberValue(query.before, 0) }),
    ...(query.after === undefined ? {} : { after: numberValue(query.after, 0) }),
    sort: query.sort === "ASC" ? ("ASC" as const) : ("DESC" as const),
  };
}

function notFound(message: string): BlueBubblesResponse {
  return failure(404, "The requested resource was not found", "Database Error", message);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function multipartField(file: MultipartFile, name: string): string | undefined {
  const raw = file.fields[name];
  const value = Array.isArray(raw) ? raw.at(-1) : raw;
  return value && value.type === "field" ? String((value as MultipartValue).value) : undefined;
}

async function saveMultipartFile(file: MultipartFile, path: string): Promise<number> {
  await pipeline(file.file, createWriteStream(path, { flags: "wx", mode: 0o600 }));
  return (await stat(path)).size;
}

function safeAttachmentName(value: string): string {
  const name = basename(value.trim());
  return name && name !== "." && name !== ".." ? name : "attachment";
}

function utiForMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "public.jpeg",
    "image/png": "public.png",
    "image/gif": "com.compuserve.gif",
    "image/heic": "public.heic",
    "image/heif": "public.heif",
    "video/mp4": "public.mpeg-4",
    "video/quicktime": "com.apple.quicktime-movie",
    "audio/mpeg": "public.mp3",
    "audio/mp4": "public.mpeg-4-audio",
    "application/pdf": "com.adobe.pdf",
    "text/vcard": "public.vcard",
  };
  return map[mime] ?? "public.data";
}

function mimeForFilename(filename: string): string {
  const extension = filename.split(".").at(-1)?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
    mp4: "video/mp4",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    pdf: "application/pdf",
    vcf: "text/vcard",
  };
  return (extension && map[extension]) || "application/octet-stream";
}

function detectImageMime(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 6).toString("ascii") === "GIF87a"
    || data.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  return "application/octet-stream";
}

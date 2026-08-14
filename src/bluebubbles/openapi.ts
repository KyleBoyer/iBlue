import type { FastifySchema, HTTPMethods } from "fastify";

import { IBLUE_BUILTIN_CONVERSATION_BACKGROUNDS } from "./backgrounds.js";

type JsonSchema = Record<string, unknown>;

const stringProperty = (description: string): JsonSchema => ({ type: "string", description });
const integerProperty = (description: string, options: JsonSchema = {}): JsonSchema => ({
  type: "integer",
  description,
  ...options,
});
const booleanProperty = (description: string): JsonSchema => ({ type: "boolean", description });
const stringArrayProperty = (description: string, options: JsonSchema = {}): JsonSchema => ({
  type: "array",
  description,
  items: { type: "string" },
  ...options,
});
const paginationProperties = {
  offset: integerProperty("Zero-based number of matching records to skip.", { minimum: 0, default: 0 }),
  limit: integerProperty("Maximum number of matching records to return.", { minimum: 1, default: 100 }),
};
const cloudSyncBody: JsonSchema = {
  type: "object",
  properties: {
    continuationToken: stringProperty("Opaque token returned by the preceding page."),
  },
};
const messageReceiptSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "messageGuid", "chatGuid", "type", "source", "eventAt"],
  properties: {
    id: { type: "integer", minimum: 1 },
    messageGuid: stringProperty("GUID of the outgoing message this receipt acknowledges."),
    chatGuid: stringProperty("BlueBubbles chat GUID containing the message."),
    type: { type: "string", enum: ["delivered", "read"] },
    handle: stringProperty("Recipient that produced the receipt, when Apple supplied one."),
    source: {
      type: "string",
      enum: ["live", "compatibility-backfill"],
      description: "Whether iBlue observed this receipt live or reconstructed it from an existing BlueBubbles timestamp.",
    },
    eventAt: { type: "integer", minimum: 0, description: "Apple event timestamp in Unix milliseconds." },
    observedAt: { type: "integer", minimum: 0, description: "Timestamp when iBlue observed the receipt locally, in Unix milliseconds. Absent for compatibility-backfill rows." },
    verificationFailed: { type: "boolean", description: "Whether IDS sender verification failed for this receipt." },
  },
};

const messageTimeQueryProperties = {
  chatGuid: stringProperty("Limit results to this BlueBubbles chat GUID."),
  after: integerProperty("Return messages created after this Unix timestamp in milliseconds."),
  before: integerProperty("Return messages created before this Unix timestamp in milliseconds."),
};

const messageEffectProperties = {
  effectId: stringProperty("Apple bubble or screen-effect identifier. Use flair instead for a friendly name."),
  flair: stringProperty("Friendly message-effect name returned by GET /api/v1/iblue/message/flair."),
};

const replyProperties = {
  selectedMessageGuid: stringProperty("GUID of the message being replied to."),
  partIndex: integerProperty("Zero-based part index within the replied-to message.", { minimum: 0, default: 0 }),
};

const scheduledMessageBody: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "payload", "scheduledFor", "schedule"],
  properties: {
    type: {
      type: "string",
      const: "send-message",
      description: "Scheduled operation type. iBlue currently supports send-message only.",
    },
    scheduledFor: integerProperty("First execution time as a future Unix timestamp in milliseconds."),
    payload: {
      type: "object",
      description: "Text-message operation to execute at the scheduled time.",
      additionalProperties: false,
      required: ["chatGuid", "message", "method"],
      properties: {
        chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
        message: stringProperty("Plain-text message body."),
        method: stringProperty("BlueBubbles scheduling method identifier retained with the job."),
        subject: stringProperty("Optional iMessage subject line."),
        attributedBody: stringProperty("Optional semantic HTML attributed body; mutually exclusive with textRuns."),
        textRuns: {
          type: "array",
          description: "Optional static-style and animation ranges measured in UTF-16 code units.",
          items: textRunSchema(),
        },
        ...messageEffectProperties,
        ...replyProperties,
      },
    },
    schedule: {
      type: "object",
      description: "One-time or recurring execution policy.",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: {
          type: "string",
          enum: ["once", "recurring"],
          description: "Whether the job runs once or repeats after each successful execution.",
        },
        interval: integerProperty("Number of intervalType units between recurring executions.", { minimum: 1 }),
        intervalType: {
          type: "string",
          enum: ["hourly", "daily", "weekly", "monthly", "yearly"],
          description: "Unit used by interval for a recurring job.",
        },
      },
    },
  },
};

const implementedCompatibilityRouteDocumentation: Record<string, FastifySchema> = {
  "GET /api/v1/server/update/check": {
    summary: "Check for an iBlue server update",
    description: "Returns a BlueBubbles-compatible no-update result. iBlue updates are managed outside the BlueBubbles Electron updater.",
    tags: ["Server"],
  },
  "GET /api/v1/server/statistics/totals": {
    summary: "Get database record totals",
    description: "Counts handles, messages, chats, and attachments stored by the active iBlue profile.",
    tags: ["Server"],
    querystring: {
      type: "object",
      properties: {
        only: stringProperty("Comma-separated resources to count: handles, messages, chats, and attachments. All are returned when omitted."),
      },
    },
  },
  "GET /api/v1/server/statistics/media": {
    summary: "Get media totals",
    description: "Counts image, video, and location attachments across the active profile.",
    tags: ["Server"],
    querystring: {
      type: "object",
      properties: {
        only: stringProperty("Comma-separated media kinds to count: images, videos, and locations. All are returned when omitted."),
      },
    },
  },
  "GET /api/v1/server/statistics/media/chat": {
    summary: "Get media totals by chat",
    description: "Returns per-chat image, video, and location counts, omitting chats whose selected totals are all zero.",
    tags: ["Server"],
    querystring: {
      type: "object",
      properties: {
        only: stringProperty("Comma-separated media kinds to count: images, videos, and locations. All are returned when omitted."),
      },
    },
  },
  "GET /api/v1/chat/count": {
    summary: "Count chats",
    description: "Returns the total number of chats stored by the active profile.",
    tags: ["Chats"],
  },
  "GET /api/v1/attachment/count": {
    summary: "Count attachments",
    description: "Returns the total number of attachment records stored by the active profile.",
    tags: ["Attachments"],
  },
  "POST /api/v1/attachment/upload": {
    summary: "Stage a reusable attachment",
    description: "Stores one multipart file temporarily and returns a profile-local path accepted by multipart messages, contact cards, and conversation backgrounds. Staged uploads expire after 24 hours.",
    tags: ["Attachments"],
    consumes: ["multipart/form-data"],
    body: {
      type: "object",
      required: ["attachment"],
      properties: {
        attachment: { type: "string", format: "binary", description: "File to stage for a later API operation." },
      },
    },
  },
  "GET /api/v1/handle/count": {
    summary: "Count message handles",
    description: "Returns the number of known recipient handles plus the active profile's registered aliases.",
    tags: ["Handles"],
  },
  "GET /api/v1/message/count": {
    summary: "Count messages",
    description: "Counts messages matching optional chat, timestamp, and row-ID bounds.",
    tags: ["Messages"],
    querystring: messageCountQuerySchema(),
  },
  "GET /api/v1/message/count/updated": {
    summary: "Count updated messages",
    description: "Counts matching messages that have edit or retraction state.",
    tags: ["Messages"],
    querystring: messageCountQuerySchema(),
  },
  "GET /api/v1/message/count/me": {
    summary: "Count outgoing messages",
    description: "Counts matching messages sent by the active iBlue profile.",
    tags: ["Messages"],
    querystring: messageCountQuerySchema(),
  },
  "POST /api/v1/handle/query": {
    summary: "Query message handles",
    description: "Lists known iMessage addresses with optional exact-address filtering and pagination.",
    tags: ["Handles"],
    body: {
      type: "object",
      properties: {
        address: stringProperty("Return handles matching this address."),
        ...paginationProperties,
      },
    },
  },
  "GET /api/v1/handle/availability/imessage": {
    summary: "Check iMessage availability",
    description: "Performs an IDS availability lookup for one phone number or email address.",
    tags: ["Handles"],
    querystring: {
      type: "object",
      required: ["address"],
      properties: { address: stringProperty("Phone number or email address to look up in IDS.") },
    },
  },
  "GET /api/v1/handle/availability/facetime": {
    summary: "Check FaceTime availability",
    description: "Reports whether this iBlue runtime has the native FaceTime signaling surface required to create and control sessions. It does not assert that a particular address is registered for FaceTime.",
    tags: ["Handles"],
    querystring: {
      type: "object",
      required: ["address"],
      properties: { address: stringProperty("Phone number or email address whose FaceTime capability is being queried.") },
    },
  },
  "GET /api/v1/handle/:guid": {
    summary: "Get a message handle",
    description: "Returns one stored Messages handle by GUID or normalized address.",
    tags: ["Handles"],
  },
  "GET /api/v1/contact": {
    summary: "List macOS contacts",
    description: "Returns an empty BlueBubbles-compatible list because Contacts.app belongs to the host macOS user. Use /api/v1/iblue/contact for profile-local contacts.",
    tags: ["Contacts"],
  },
  "POST /api/v1/contact/query": {
    summary: "Query macOS contacts",
    description: "Returns an empty BlueBubbles-compatible list without reading the host user's Contacts.app database. Use /api/v1/iblue/contact/query instead.",
    tags: ["Contacts"],
  },
  "GET /api/v1/fcm/client": {
    summary: "Get FCM configuration status",
    description: "Returns BlueBubbles' expected Google Services not-found response; iBlue uses Socket.IO and webhooks instead of Firebase Cloud Messaging.",
    tags: ["FCM"],
  },
  "POST /api/v1/chat/query": {
    summary: "Query chats",
    description: "Returns paginated chats and can include each chat's latest message.",
    tags: ["Chats"],
    body: {
      type: "object",
      properties: {
        ...paginationProperties,
        with: stringArrayProperty("Related values to include. Use lastMessage or last-message to include the latest message."),
      },
    },
  },
  "PUT /api/v1/chat/:guid": {
    summary: "Rename a group chat",
    description: "Changes a group conversation's display name. A missing displayName leaves the chat unchanged.",
    tags: ["Chats"],
    body: {
      type: "object",
      properties: { displayName: stringProperty("New group-chat display name.") },
    },
  },
  "GET /api/v1/chat/:guid": {
    summary: "Get a chat",
    description: "Returns one chat and optionally includes participant and latest-message relationships.",
    tags: ["Chats"],
    querystring: {
      type: "object",
      properties: { with: stringProperty("Comma-separated related values: participants and lastMessage.") },
    },
  },
  "DELETE /api/v1/chat/:guid": {
    summary: "Delete a local chat",
    description: "Deletes the chat and its locally stored messages and attachment references from iBlue. It does not retract messages from recipients.",
    tags: ["Chats"],
  },
  "POST /api/v1/chat/:guid/participant": participantRouteDocumentation("Add a group participant", "Adds one address to the group conversation."),
  "DELETE /api/v1/chat/:guid/participant": participantRouteDocumentation("Remove a group participant", "Removes one address from the group conversation."),
  "POST /api/v1/chat/:guid/participant/add": participantRouteDocumentation("Add a group participant", "BlueBubbles alias for adding one address to the group conversation."),
  "POST /api/v1/chat/:guid/participant/remove": participantRouteDocumentation("Remove a group participant", "BlueBubbles alias for removing one address from the group conversation."),
  "GET /api/v1/chat/:guid/icon": {
    summary: "Download a group-chat icon",
    description: "Returns the currently stored group image as its original media type.",
    tags: ["Chats"],
  },
  "POST /api/v1/chat/:guid/icon": {
    summary: "Set a group-chat icon",
    description: "Uploads and publishes a new group image for the conversation.",
    tags: ["Chats"],
    consumes: ["multipart/form-data"],
    body: {
      type: "object",
      required: ["icon"],
      properties: { icon: { type: "string", format: "binary", description: "Image file to use as the group icon." } },
    },
  },
  "DELETE /api/v1/chat/:guid/icon": {
    summary: "Remove a group-chat icon",
    description: "Publishes a group update that removes the conversation image.",
    tags: ["Chats"],
  },
  "POST /api/v1/chat/:guid/read": {
    summary: "Mark a chat read",
    description: "Marks the conversation read and sends an iMessage read receipt through the selected message when supplied.",
    tags: ["Chats"],
    body: {
      type: "object",
      properties: { messageGuid: stringProperty("Optional newest message GUID to acknowledge as read.") },
    },
  },
  "POST /api/v1/chat/:guid/unread": {
    summary: "Mark a chat unread",
    description: "Marks the conversation unread in iBlue's local store.",
    tags: ["Chats"],
  },
  "POST /api/v1/chat/:guid/leave": {
    summary: "Leave a group chat",
    description: "Publishes an iMessage group-participant update removing the active profile from the conversation.",
    tags: ["Chats"],
  },
  "GET /api/v1/chat/:guid/share/contact/status": {
    summary: "Get contact-sharing status",
    description: "Returns false because host Contacts.app sharing is outside iBlue's profile-isolated service.",
    tags: ["Chats"],
  },
  "POST /api/v1/chat/:guid/typing": {
    summary: "Start a typing indicator",
    description: "Publishes an active iMessage typing indicator to the conversation.",
    tags: ["Chats"],
  },
  "DELETE /api/v1/chat/:guid/typing": {
    summary: "Stop a typing indicator",
    description: "Publishes an inactive iMessage typing indicator to the conversation.",
    tags: ["Chats"],
  },
  "GET /api/v1/chat/:guid/message": {
    summary: "List messages in a chat",
    description: "Returns a paginated, time-bounded page of messages from one conversation.",
    tags: ["Chats"],
    querystring: messageListQuerySchema(),
  },
  "POST /api/v1/chat/new": {
    summary: "Create a chat",
    description: "Creates or resolves a direct/group iMessage conversation and can send its first text message.",
    tags: ["Chats"],
    body: {
      type: "object",
      required: ["addresses"],
      properties: {
        addresses: stringArrayProperty("One or more participant phone numbers or email addresses.", { minItems: 1 }),
        message: stringProperty("Optional initial plain-text message."),
        subject: stringProperty("Optional subject for the initial message."),
        tempGuid: stringProperty("Optional client-generated correlation GUID for the initial message."),
        ...messageEffectProperties,
      },
    },
  },
  "DELETE /api/v1/chat/:guid/:messageGuid": {
    summary: "Delete a locally stored message",
    description: "Deletes one message and its unreferenced attachment files from iBlue's local store. This is not an iMessage unsend.",
    tags: ["Chats"],
  },
  "POST /api/v1/message/query": {
    summary: "Query messages",
    description: "Returns messages using pagination, chat, time, sort, and BlueBubbles row-ID bounds.",
    tags: ["Messages"],
    body: messageQueryBodySchema(),
  },
  "GET /api/v1/message/schedule": {
    summary: "List scheduled messages",
    description: "Returns every pending one-time and recurring message owned by the active profile.",
    tags: ["Messages"],
  },
  "POST /api/v1/message/schedule": {
    summary: "Create a scheduled message",
    description: "Creates a durable one-time or recurring text-message job.",
    tags: ["Messages"],
    body: scheduledMessageBody,
  },
  "GET /api/v1/message/schedule/:id": {
    summary: "Get a scheduled message",
    description: "Returns one scheduled-message job by numeric ID, or a successful null when it does not exist for BlueBubbles compatibility.",
    tags: ["Messages"],
  },
  "PUT /api/v1/message/schedule/:id": {
    summary: "Replace a scheduled message",
    description: "Replaces the complete payload and timing policy of an existing scheduled-message job.",
    tags: ["Messages"],
    body: scheduledMessageBody,
  },
  "DELETE /api/v1/message/schedule/:id": {
    summary: "Delete a scheduled message",
    description: "Removes a pending scheduled-message job by numeric ID.",
    tags: ["Messages"],
  },
  "GET /api/v1/message/:guid": {
    summary: "Get a message",
    description: "Returns one normalized message by its iMessage GUID.",
    tags: ["Messages"],
  },
  "POST /api/v1/message/:guid/edit": editRouteDocumentation(false),
  "POST /api/v1/message/edit": editRouteDocumentation(true),
  "POST /api/v1/message/:guid/unsend": unsendRouteDocumentation(false),
  "POST /api/v1/message/delete": unsendRouteDocumentation(true),
  "POST /api/v1/message/:guid/notify": {
    summary: "Send Notify Anyway",
    description: "Sends Apple's urgent Focus-bypass control for a previously sent message.",
    tags: ["Messages"],
  },
  "GET /api/v1/message/:guid/embedded-media": {
    summary: "Download a message's embedded media",
    description: "Returns the first downloaded attachment associated with the selected message.",
    tags: ["Messages"],
  },
  "POST /api/v1/message/attachment": {
    summary: "Send an attachment",
    description: "Uploads one file through MMCS and sends it as an iMessage attachment, including audio-message and reply metadata when requested.",
    tags: ["Messages"],
    consumes: ["multipart/form-data"],
    body: attachmentMessageBodySchema(),
  },
  "POST /api/v1/message/multipart": {
    summary: "Send a multipart message",
    description: "Sends an ordered mixture of text, mentions, and previously staged attachments in one iMessage.",
    tags: ["Messages"],
    body: multipartMessageBodySchema(),
  },
  "GET /api/v1/attachment/:guid/download": {
    summary: "Download an attachment",
    description: "Streams the locally downloaded attachment bytes with their stored MIME type and filename.",
    tags: ["Attachments"],
  },
  "GET /api/v1/attachment/:guid/download/force": {
    summary: "Download an attachment immediately",
    description: "Alias of the normal download route. Direct IDS receive already downloads MMCS content before exposing the attachment.",
    tags: ["Attachments"],
  },
  "GET /api/v1/attachment/:guid": {
    summary: "Get attachment metadata",
    description: "Returns normalized metadata for one stored attachment without embedding its bytes.",
    tags: ["Attachments"],
  },
  "GET /api/v1/webhook": {
    summary: "List webhooks",
    description: "Lists registered webhook destinations with optional ID or URL filtering.",
    tags: ["Webhooks"],
    querystring: {
      type: "object",
      properties: {
        id: integerProperty("Return only the webhook with this numeric ID.", { minimum: 1 }),
        url: stringProperty("Return webhooks whose destination URL matches this value."),
      },
    },
  },
  "POST /api/v1/webhook": {
    summary: "Create a webhook",
    description: "Registers an HTTP(S) destination for one or more supported realtime event names.",
    tags: ["Webhooks"],
    body: {
      type: "object",
      required: ["url", "events"],
      properties: {
        url: { type: "string", format: "uri", description: "HTTP or HTTPS webhook destination." },
        events: stringArrayProperty("Event names to deliver. Use * to subscribe to all events.", { minItems: 1 }),
      },
    },
  },
  "DELETE /api/v1/webhook/:id": {
    summary: "Delete a webhook",
    description: "Deletes one webhook registration by numeric ID.",
    tags: ["Webhooks"],
  },
};

const routeDocumentation: Record<string, FastifySchema> = {
  ...implementedCompatibilityRouteDocumentation,
  "GET /api/v1/ping": {
    summary: "Check API availability",
    description: "Returns a BlueBubbles-compatible pong envelope.",
    tags: ["Server"],
  },
  "GET /api/v1/server/info": {
    summary: "Get server information",
    description: "Returns BlueBubbles compatibility metadata and additive iBlue capabilities.",
    tags: ["Server"],
  },
  "POST /api/v1/iblue/facetime/session": {
    summary: "Create an outbound FaceTime session",
    description: "Creates a profile-isolated Apple FaceTime signaling session without ringing immediately. Opening the returned Apple web-join URL admits the media participant and then rings the target. This separation prevents phantom calls when media startup fails.",
    tags: ["iBlue FaceTime"],
    body: {
      type: "object",
      additionalProperties: false,
      properties: {
        address: stringProperty("One phone number or email address to call. Use targets for a group call."),
        targets: stringArrayProperty("Phone numbers or email addresses to call.", { minItems: 1, maxItems: 32 }),
        from: stringProperty("Optional registered Jade/iBlue sending handle. The profile's first handle is used by default."),
        displayName: stringProperty("Display name shown for the isolated web participant."),
        ringTtlSeconds: integerProperty("How long the pending ring may wait for media to join.", { minimum: 15, maximum: 3600, default: 120 }),
      },
      anyOf: [{ required: ["address"] }, { required: ["targets"] }],
    },
  },
  "GET /api/v1/iblue/facetime/session": {
    summary: "List FaceTime signaling sessions",
    description: "Returns the native rustpush FaceTime session state, including participants, members, direction, and timestamps. Cryptographic link secrets remain confined to the profile state and are not added to message records.",
    tags: ["iBlue FaceTime"],
  },
  "POST /api/v1/iblue/facetime/session/:sessionId/leave": {
    summary: "Leave a FaceTime signaling session",
    description: "Cancels a not-yet-fired pending ring and removes the iBlue IDS signaling participant when it is still present. A running web media leg must also be stopped by the call endpoint that owns it.",
    tags: ["iBlue FaceTime"],
    params: {
      type: "object",
      required: ["sessionId"],
      properties: { sessionId: stringProperty("Uppercase FaceTime session UUID returned at creation time.") },
    },
  },
  "GET /api/v1/iblue/facetime/capabilities": {
    summary: "Get FaceTime runtime capabilities",
    description: "Reports signaling, deterministic media transport, identity/topology, supported mode, lifecycle event, codec, verification state, inbound streaming, and outbound live-injection availability separately so agent harnesses can feature-detect each layer without attempting a call. On macOS, uploaded audio uses a one-to-one iBlue-owned QuickRelay session authenticated as the selected profile (for example Jade); it does not use FaceTime.app, the macOS user's FaceTime account, or an Apple web guest. Both ordinary generated-source transcoding and byte-for-byte replay of phone-originated AAC-ELD/PT104 have been verified with clear playback and automatic hangup on an answered iPhone call. Live injection is reported separately until its listening test is complete. Uploaded video remains on the reported Apple web-guest group-call fallback until native AVC video sending is available.",
    tags: ["iBlue FaceTime"],
  },
  "GET /api/v1/iblue/facetime/realtime": {
    summary: "Get FaceTime realtime protocol metadata",
    description: "Authoritative machine-readable event map for authenticated Socket.IO call controls, explicit time-limited inbound-media subscriptions, and outbound live audio injection. Raw microphone/camera frames are delivered only to opted-in authenticated sockets and are never persisted, placed in API events, or forwarded to webhooks. A live outbound stream is exclusively owned by its creating socket; 20 ms 24 kHz mono float32 frames are individually acknowledged, encoded persistently as FaceTime AAC-ELD/PT104, bounded by a 50-frame queue and a 15–600 second safety deadline, and the call is ended if the owner disconnects. OpenAPI cannot model Socket.IO events directly, so clients must feature-detect and consume the event definitions returned here.",
    tags: ["iBlue FaceTime"],
  },
  "GET /api/v1/iblue/facetime/call": {
    summary: "List FaceTime media calls",
    description: "Returns public lifecycle state for deterministic FaceTime media calls made since this server process started. Local source paths, browser handles, and Apple join credentials are never returned.",
    tags: ["iBlue FaceTime"],
  },
  "GET /api/v1/iblue/facetime/call/:callId": {
    summary: "Get a FaceTime media call",
    description: "Returns mode, target, lifecycle state, timestamps, converted-media/capture timing, native and web participant counts, native sender state and packet/byte totals, WebRTC connection state, audio byte/energy counters, video byte/frame counters, and any startup or transport failure for one call. Native calls also expose privacy-safe VC-control diagnostics: messages received, authenticated and sent; whether microphone stream state was published; whether the control handshake is ready; participant, peer-UUID and media-key context counts; and a stable last-error code. Peer-audio diagnostics include the observed inbound payload type, exact RTP extension profile, and the peer's complete proprietary extension as hexadecimal control metadata. The older feedback sequence/kilobyte/packet fields remain best-effort interpretations while Apple's private extension layout is being verified and must not alone be treated as delivery proof. No key, control payload, or media bytes are exposed.",
    tags: ["iBlue FaceTime"],
    params: {
      type: "object",
      required: ["callId"],
      properties: { callId: stringProperty("iBlue media-call UUID returned by POST /api/v1/iblue/facetime/call.") },
    },
  },
  "POST /api/v1/iblue/facetime/call": {
    summary: "Call with deterministic uploaded audio or video",
    description: "Accepts one audio or video upload, rings the target, plays the media once, and hangs up after native sender completion or at the safety deadline. On macOS, ordinary audio is converted with Apple's AudioToolbox pipeline to mono 24 kHz AAC-ELD as one 480-sample (20 ms) PT104 access unit per RTP packet, matching the payload-to-codec clock mapping in Apple's AVConference runtime and the timing observed from current iPhone peers. For codec diagnostics, nativeAudioPassthrough=true accepts an already encoded AAC-ELD CAF and preserves every PT104 access unit byte-for-byte after strict preflight validation. Audio is sent by the selected iBlue profile over its native one-to-one IDS/QuickRelay session after the callee answers, media keys are ready, and the peer's authenticated Apple RTP extension/routing template is observed. The call lifecycle identifies AAC-ELD transcoding versus passthrough, exposes native packet, payload-byte, control-handshake, and peer-feedback totals, and fails rather than reporting active when that sender cannot start. It does not involve FaceTime.app or a web guest. Video currently uses an isolated Apple web participant and therefore appears as a group call; that fallback browser is destroyed at call end. Only one deterministic media call may run at a time.",
    tags: ["iBlue FaceTime"],
    consumes: ["multipart/form-data"],
    body: {
      type: "object",
      required: ["media"],
      properties: {
        media: { type: "string", format: "binary", description: "Audio or video source, up to 95 MiB. Video sources must contain an audio track." },
        address: stringProperty("One phone number or email address to call."),
        targets: stringProperty("JSON array or comma-separated list of phone numbers and email addresses."),
        mode: { type: "string", enum: ["audio", "video"], description: "Call mode. Defaults from the upload MIME type." },
        displayName: stringProperty("Participant name shown by Apple. Defaults to iBlue."),
        from: stringProperty("Optional registered iBlue FaceTime handle."),
        maxDurationSeconds: integerProperty("Hard safety deadline after media handoff. iBlue hangs up earlier when the converted media reaches its play-once deadline.", { minimum: 15, maximum: 600, default: 90 }),
        nativeAudioPassthrough: { type: "boolean", default: false, description: "Audio-only diagnostic mode that bypasses iBlue's ordinary source conversion. The upload must be an Apple CAF containing 24 kHz AAC-ELD with exactly 480 frames per packet; iBlue validates it before ringing and sends the access units as PT104 without transcoding." },
      },
      anyOf: [{ required: ["address"] }, { required: ["targets"] }],
    },
  },
  "DELETE /api/v1/iblue/facetime/call/:callId": {
    summary: "End a FaceTime media call",
    description: "Aborts native QuickRelay media when present, clicks Apple's web leave control for fallback calls, removes iBlue's signaling participant, closes any isolated browser, and deletes converted temporary media.",
    tags: ["iBlue FaceTime"],
    params: {
      type: "object",
      required: ["callId"],
      properties: { callId: stringProperty("iBlue media-call UUID to stop.") },
    },
  },
  "GET /api/v1/iblue/contact": {
    summary: "List profile-local contacts",
    description: "Searches contacts learned from profile VCF imports, iCloud CardDAV, and Name & Photo Sharing.",
    tags: ["iBlue Contacts"],
    querystring: {
      type: "object",
      properties: {
        address: stringProperty("Return contacts matching this Messages address."),
        search: stringProperty("Case-insensitive name or address search."),
        ...paginationProperties,
      },
    },
  },
  "POST /api/v1/iblue/contact/query": {
    summary: "Query profile-local contacts",
    description: "Searches the profile-isolated contact cache by one or more addresses, free text, and source.",
    tags: ["iBlue Contacts"],
    body: {
      type: "object",
      properties: {
        addresses: stringArrayProperty("Return contacts matching any of these Messages phone numbers or email addresses."),
        search: stringProperty("Case-insensitive display-name or address search."),
        sources: {
          type: "array",
          description: "Restrict results to one or more contact data sources.",
          items: { type: "string", enum: ["profile-vcf", "icloud-carddav", "name-and-photo-sharing"] },
        },
        ...paginationProperties,
      },
    },
  },
  "POST /api/v1/iblue/contact/icloud/sync": {
    summary: "Sync real iCloud Contacts",
    description: "Fetches the signed-in Apple account's CardDAV address books and replaces the iCloud contact cache.",
    tags: ["iBlue Contacts"],
  },
  "GET /api/v1/handle/:guid/focus": {
    summary: "Get and subscribe to a handle's Focus status",
    description: "Returns the portable availability signal and its notificationsSilenced inverse. mode, when present, is an opaque per-person Focus UUID and must not be interpreted as a global mode identifier.",
    tags: ["iBlue Focus"],
  },
  "POST /api/v1/iblue/focus/sync": {
    summary: "Recover Focus sharing keys from iCloud",
    description: "Fetches and decrypts StatusKit invitations from the signed-in account's private iCloud database, injects recovered peer keys, and subscribes to their Focus channels. While done is false, pass the returned zone and continuation token to fetch the next page. Retain the final token to resume a later incremental sync.",
    tags: ["iBlue Focus"],
    body: {
      type: "object",
      properties: {
        cachedZone: { type: "string", description: "Resolved StatusKit CloudKit zone returned by a previous page." },
        continuationToken: { type: "string", description: "Base64 continuation token returned by a previous page." },
      },
    },
  },
  "POST /api/v1/iblue/focus/subscribe": {
    summary: "Subscribe to Focus status updates",
    description: "Subscribes to StatusKit updates for up to 256 Messages addresses and returns their current portable availability state.",
    tags: ["iBlue Focus"],
    body: {
      type: "object",
      required: ["handles"],
      properties: {
        handles: stringArrayProperty("Messages phone numbers or email addresses to subscribe to.", { minItems: 1, maxItems: 256 }),
      },
    },
  },
  "POST /api/v1/iblue/focus/share": {
    summary: "Publish this account's Focus status",
    description: "Publishes whether the active iBlue profile is available to subscribed peers; an opaque mode value may accompany a silenced state.",
    tags: ["iBlue Focus"],
    body: {
      type: "object",
      required: ["active"],
      properties: {
        active: { type: "boolean", description: "True means available; false publishes an active Focus mode." },
        mode: { type: "string", description: "Required when active is false." },
      },
    },
  },
  "GET /api/v1/iblue/contact/vcf": {
    summary: "Export the profile VCF",
    description: "Returns the complete profile-local vCard document used for imported contact names and avatars.",
    tags: ["iBlue Contacts"],
  },
  "PUT /api/v1/iblue/contact/vcf": {
    summary: "Import a profile VCF",
    description: "Replaces the profile-local vCard document and rebuilds its normalized contact cache.",
    tags: ["iBlue Contacts"],
    body: {
      type: "object",
      required: ["vcf"],
      properties: { vcf: stringProperty("Complete vCard text to import.") },
    },
  },
  "GET /api/v1/iblue/contact/:address/avatar": {
    summary: "Download a contact avatar",
    description: "Returns the cached portrait for a profile-local contact identified by phone number or email address.",
    tags: ["iBlue Contacts"],
  },
  "POST /api/v1/iblue/contact-card": {
    summary: "Create and send a contact card",
    description: "Builds an Apple-compatible vCard 3.0 attachment from structured fields. To embed a portrait, first upload a JPEG or PNG with POST /api/v1/attachment/upload and pass its returned path as photo, or reference an existing image with photoAttachmentGuid.",
    tags: ["iBlue Contacts"],
    body: {
      type: "object",
      required: ["chatGuid", "displayName"],
      additionalProperties: false,
      properties: {
        chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
        displayName: { type: "string", minLength: 1, maxLength: 512, description: "Display name shown on the contact card." },
        firstName: stringProperty("Given name."),
        middleName: stringProperty("Middle name."),
        lastName: stringProperty("Family name."),
        prefix: stringProperty("Honorific prefix such as Dr. or Ms."),
        suffix: stringProperty("Name suffix such as Jr. or PhD."),
        nickname: stringProperty("Contact nickname."),
        organization: stringProperty("Company or organization name."),
        department: stringProperty("Department within the organization."),
        title: stringProperty("Job title."),
        birthday: { type: "string", description: "vCard birthday value, normally YYYY-MM-DD." },
        note: stringProperty("Free-form contact note."),
        photo: stringProperty("Staged JPEG or PNG path returned by POST /api/v1/attachment/upload."),
        photoAttachmentGuid: stringProperty("GUID of an existing downloaded JPEG or PNG attachment."),
        phones: { type: "array", description: "Labeled phone numbers.", maxItems: 32, items: contactCardFieldSchema() },
        emails: { type: "array", description: "Labeled email addresses.", maxItems: 32, items: contactCardFieldSchema() },
        urls: { type: "array", description: "Labeled website URLs.", maxItems: 32, items: contactCardFieldSchema() },
        socialProfiles: {
          type: "array",
          description: "Labeled social-network profiles.",
          maxItems: 32,
          items: {
            ...contactCardFieldSchema(),
            properties: {
              ...((contactCardFieldSchema().properties ?? {}) as Record<string, unknown>),
              service: stringProperty("Social-network service name."),
              userId: stringProperty("Account identifier on the social-network service."),
            },
          },
        },
        addresses: {
          type: "array",
          description: "Structured postal addresses.",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: stringProperty("Human-readable label such as home or work."),
              types: stringArrayProperty("vCard type tokens such as HOME or WORK."),
              extended: stringProperty("Apartment, suite, or other extended-address value."),
              street: stringProperty("Street address."),
              city: stringProperty("City or locality."),
              region: stringProperty("State, province, or region."),
              postalCode: stringProperty("Postal or ZIP code."),
              country: stringProperty("Country name or code."),
              preferred: booleanProperty("Whether this is the preferred postal address."),
            },
          },
        },
      },
    },
  },
  "GET /api/v1/iblue/contact-card/:attachmentGuid/photo": {
    summary: "Download an embedded contact-card portrait",
    description: "Returns the decoded portrait without placing its base64 payload in message JSON.",
    tags: ["iBlue Contacts"],
    querystring: {
      type: "object",
      properties: { cardIndex: integerProperty("Zero-based vCard index when the attachment contains multiple contacts.", { minimum: 0, default: 0 }) },
    },
  },
  "GET /api/v1/iblue/message/flair": {
    summary: "List supported message effects",
    description: "Returns friendly names and Apple wire identifiers for bubble and screen effects.",
    tags: ["iBlue Messages"],
  },
  "GET /api/v1/iblue/message/text-effects": {
    summary: "List modern attributed-text capabilities",
    description: "Returns the four static styles, eight inline animations, and UTF-16 range convention supported by iBlue.",
    tags: ["iBlue Messages"],
  },
  "GET /api/v1/iblue/message/:guid/receipts": {
    summary: "List per-recipient delivery and read receipts",
    description: "Returns durable receipt history for an outgoing message. Each recipient/type pair is retained once, including Apple event time and, for live receipts, local observation time. Existing BlueBubbles timestamps are retained as compatibility-backfill records without inventing a recipient or observation time. dateDelivered and dateRead remain first-observed compatibility summaries. An empty read history means no receipt was observed; it does not prove the message is unread because recipients can disable read receipts.",
    tags: ["iBlue Messages"],
    params: {
      type: "object",
      required: ["guid"],
      properties: {
        guid: stringProperty("GUID of the outgoing message."),
      },
    },
    querystring: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["delivered", "read"], description: "Return only delivered or read receipt events." },
        handle: stringProperty("Optionally filter by recipient address."),
        offset: integerProperty("Zero-based number of matching receipt records to skip.", { minimum: 0, default: 0 }),
        limit: integerProperty("Maximum matching receipt records to return.", { minimum: 1, maximum: 1000, default: 100 }),
      },
    },
    response: {
      200: {
        type: "object",
        additionalProperties: false,
        required: ["status", "message", "data", "metadata"],
        properties: {
          status: { type: "integer", const: 200 },
          message: { type: "string" },
          data: { type: "array", items: messageReceiptSchema },
          metadata: {
            type: "object",
            additionalProperties: false,
            required: ["total", "offset", "limit", "count"],
            properties: {
              total: { type: "integer", minimum: 0 },
              offset: { type: "integer", minimum: 0 },
              limit: { type: "integer", minimum: 1 },
              count: { type: "integer", minimum: 0 },
            },
          },
        },
      },
    },
  },
  "POST /api/v1/message/text": {
    summary: "Send a text message",
    description: "BlueBubbles-compatible text send with additive iBlue textRuns for static formatting and per-range animations.",
    tags: ["Messages"],
    body: {
      type: "object",
      required: ["chatGuid", "message"],
      additionalProperties: true,
      properties: {
        chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
        message: stringProperty("Plain-text message body."),
        attributedBody: { type: "string", description: "Advanced semantic HTML input." },
        textRuns: {
          type: "array",
          description: "Sorted, non-overlapping NSRange-compatible runs measured in UTF-16 code units.",
          items: textRunSchema(),
        },
        tempGuid: stringProperty("Optional client-generated correlation GUID."),
        subject: stringProperty("Optional iMessage subject line."),
        ...messageEffectProperties,
        ...replyProperties,
      },
    },
  },
  "POST /api/v1/message/react": {
    summary: "Send a Tapback reaction",
    description: "Supports the six BlueBubbles Tapbacks plus additive emoji/-emoji reactions with an emoji field.",
    tags: ["Messages"],
    body: {
      type: "object",
      required: ["chatGuid", "selectedMessageGuid", "reaction"],
      properties: {
        chatGuid: stringProperty("Chat containing the target message."),
        selectedMessageGuid: stringProperty("GUID of the target message."),
        partIndex: integerProperty("Zero-based part index within the target message.", { minimum: 0, default: 0 }),
        reaction: {
          type: "string",
          description: "Tapback to add, or the same name prefixed with - to remove. emoji and -emoji require emoji.",
          enum: [
            "love", "like", "dislike", "laugh", "emphasize", "question",
            "-love", "-like", "-dislike", "-laugh", "-emphasize", "-question",
            "emoji", "-emoji",
          ],
        },
        emoji: { type: "string", description: "One emoji grapheme; required for emoji and -emoji." },
      },
    },
  },
  "POST /api/v1/iblue/message/sticker": {
    summary: "Send a sticker-family Tapback",
    description: "Uploads a sticker image through MMCS and attaches it to an existing message as an Apple type-7 reaction. The source selects ordinary Sticker, Memoji, or Genmoji attribution.",
    tags: ["iBlue Messages"],
    consumes: ["multipart/form-data"],
    body: {
      type: "object",
      required: ["chatGuid", "selectedMessageGuid", "sticker"],
      properties: {
        chatGuid: stringProperty("Chat containing the target message."),
        selectedMessageGuid: stringProperty("GUID of the target message."),
        partIndex: integerProperty("Zero-based part index within the target message.", { minimum: 0, default: 0 }),
        source: { type: "string", enum: ["sticker", "memoji", "genmoji"], default: "sticker", description: "Apple sticker-family attribution to encode." },
        sticker: {
          type: "string",
          format: "binary",
          description: "PNG, GIF, JPEG, or HEIC sticker image, at most 500 KB.",
        },
      },
    },
  },
  "POST /api/v1/iblue/message/sticker/update": {
    summary: "Resize an outgoing sticker",
    description: "Sends an Apple extension update for a sticker previously sent by this iBlue profile. Apple does not provide remote deletion for modern attached stickers; deletion from Sticker Details is local to the recipient device.",
    tags: ["iBlue Messages"],
    body: {
      type: "object",
      required: ["chatGuid", "messageGuid", "scale"],
      properties: {
        chatGuid: stringProperty("Chat containing the sticker."),
        messageGuid: stringProperty("GUID returned when the sticker was sent."),
        scale: { type: "number", minimum: 0.05, maximum: 2, description: "Rendered sticker scale relative to Apple's base sticker size." },
      },
    },
  },
  "POST /api/v1/iblue/rich-link": {
    summary: "Send a rich link or Apple Music card",
    description: "Builds and sends an Apple rich-link balloon. Supplying complete Apple Music metadata produces the native playable Music card.",
    tags: ["iBlue Messages"],
    body: {
      type: "object",
      required: ["chatGuid", "originalUrl"],
      additionalProperties: true,
      properties: {
        chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
        originalUrl: { type: "string", format: "uri", description: "Original destination URL encoded in the rich-link payload." },
        url: { type: "string", format: "uri", description: "Canonical URL opened when the recipient taps the card; defaults to originalUrl." },
        title: stringProperty("Headline shown in a generic rich-link card."),
        summary: stringProperty("Supporting description shown in a generic rich-link card."),
        artworkAttachmentGuid: stringProperty("GUID of an existing downloaded image to use as card artwork."),
        appleMusic: {
          type: "object",
          description: "Complete Apple Music playback metadata required to render the native play button.",
          additionalProperties: false,
          required: ["storefrontIdentifier", "storeIdentifier", "name", "artist", "album", "previewUrl"],
          properties: {
            storefrontIdentifier: stringProperty("Apple Music storefront code, such as us."),
            storeIdentifier: stringProperty("Apple Music catalog song identifier."),
            name: stringProperty("Track title."),
            artist: stringProperty("Artist display name."),
            album: stringProperty("Album display name."),
            previewUrl: { type: "string", format: "uri", description: "Public Apple Music audio-preview URL used by the inline play button." },
          },
        },
      },
    },
  },
  "POST /api/v1/iblue/message/component": {
    summary: "Send a generic iMessage component envelope",
    description: "Sends a normalized MSMessageTemplateLayout balloon without exposing keyed-archive internals. Received components expose rendered artwork through message.iBlue.component.image with an attachment GUID and download URL.",
    tags: ["iBlue Messages"],
    body: {
      type: "object",
      required: ["chatGuid", "bundleId", "url"],
      additionalProperties: false,
      properties: {
        chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
        bundleId: { type: "string", maxLength: 512, description: "Messages extension bundle identifier that owns the component." },
        appName: stringProperty("Extension display name shown by Messages."),
        appId: integerProperty("Numeric App Store identifier when known.", { minimum: 0 }),
        url: { type: "string", maxLength: 16384, description: "Component data URL opened by the owning Messages extension." },
        sessionId: { type: "string", format: "uuid", description: "Stable UUID connecting updates to the same component session." },
        isLive: booleanProperty("Whether this component represents an active live session."),
        ldText: stringProperty("Accessibility and link-description text carried by the component."),
        imageTitle: stringProperty("Primary text overlaid in the template image region."),
        imageSubtitle: stringProperty("Secondary text overlaid in the template image region."),
        caption: stringProperty("Primary caption beneath the image region."),
        subcaption: stringProperty("Secondary caption beneath the image region."),
        secondarySubcaption: stringProperty("Additional secondary template caption."),
        tertiarySubcaption: stringProperty("Additional tertiary template caption."),
        iconAttachmentGuid: stringProperty("GUID of an existing downloaded image to render as the component artwork."),
        text: stringProperty("Optional plain text stored with the component message."),
        subject: stringProperty("Optional iMessage subject stored with the component."),
        replyGuid: stringProperty("GUID of a message this component replies to."),
        replyPart: stringProperty("Part identifier within the replied-to message."),
      },
    },
  },
  "GET /api/v1/iblue/chat/:guid/background": {
    summary: "Get a conversation background",
    description: "Returns the normalized photo, color, Sky, Water, Aurora, or none background currently stored for the conversation.",
    tags: ["iBlue Messages"],
  },
  "GET /api/v1/iblue/background/presets": {
    summary: "List built-in animated conversation backgrounds",
    description: "Lists every Apple DynamicBackgroundPosterExtension preset accepted by the background endpoint.",
    tags: ["iBlue Messages"],
  },
  "POST /api/v1/iblue/chat/:guid/background": {
    summary: "Set or remove a conversation background",
    description: "Publishes a conversation background update using a staged photo, stored attachment, built-in preset, or removal flag.",
    tags: ["iBlue Messages"],
    body: {
      type: "object",
      properties: {
        attachmentGuid: { type: "string", description: "Previously uploaded image attachment." },
        attachment: { type: "string", description: "Staged path returned by POST /api/v1/attachment/upload." },
        preset: {
          type: "string",
          enum: IBLUE_BUILTIN_CONVERSATION_BACKGROUNDS.map((background) => background.identifier),
          description: "Built-in Color, Sky, Water, or Aurora background identifier. Mutually exclusive with attachment and attachmentGuid.",
        },
        colors: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: { type: "string", pattern: "^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$" },
          description: "Two gradient colors. Required only when preset is color.",
        },
        remove: booleanProperty("Remove the current conversation background and return to none."),
      },
    },
  },
  "POST /api/v1/iblue/cloud/messages/chats/sync": {
    summary: "Sync a Messages in iCloud chat page",
    description: "Fetches and persists one paginated Messages in iCloud conversation page for the active profile.",
    tags: ["iBlue Cloud Sync"],
    body: cloudSyncBody,
  },
  "POST /api/v1/iblue/cloud/messages/messages/sync": {
    summary: "Sync a Messages in iCloud message page",
    description: "Fetches and persists one paginated Messages in iCloud message page for the active profile.",
    tags: ["iBlue Cloud Sync"],
    body: cloudSyncBody,
  },
  "POST /api/v1/iblue/cloud/messages/attachments/sync": {
    summary: "Sync a Messages in iCloud attachment-metadata page",
    description: "Fetches and persists one paginated Messages in iCloud attachment-metadata page without downloading all media bytes.",
    tags: ["iBlue Cloud Sync"],
    body: cloudSyncBody,
  },
  "GET /api/v1/iblue/icloud-share/:messageGuid": {
    summary: "Resolve an iCloud Photos share",
    description: "Resolves the iCloud Photos URL in a message into album metadata and downloadable original, medium, and thumbnail variants.",
    tags: ["iBlue iCloud Photos"],
  },
  "GET /api/v1/iblue/icloud-share/:messageGuid/item/:itemGuid/:variant": {
    summary: "Download shared iCloud media",
    description: "Variant must be original, medium, or thumbnail.",
    tags: ["iBlue iCloud Photos"],
  },
  "POST /api/v1/iblue/icloud-share": {
    summary: "Send an existing iCloud Photos share",
    description: "Sends an already-created public iCloud Photos URL as a native Photos Messages card.",
    tags: ["iBlue iCloud Photos"],
    body: {
      type: "object",
      required: ["chatGuid", "url"],
      properties: {
        chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
        url: { type: "string", format: "uri", description: "Public share URL from share.icloud.com or www.icloud.com/photos." },
        caption: stringProperty("Primary Photos card caption."),
        subcaption: stringProperty("Secondary Photos card caption."),
        ldText: stringProperty("Accessibility and link-description text for the card."),
      },
    },
  },
  "POST /api/v1/iblue/icloud-share/create": {
    summary: "Create and send a fresh iCloud Photos share",
    description: "Uploads one Photos-compatible image or video to the opted-in iCloud web session, creates a fresh public share, waits for anonymous access, and sends its native Photos Messages card. JPEG, PNG, HEIC/HEIF, QuickTime MOV, and MP4 are live-verified. Apple's web importer rejects GIF; use the ordinary iMessage attachment API for animated GIFs.",
    tags: ["iBlue iCloud Photos"],
    consumes: ["multipart/form-data"],
    body: {
      type: "object",
      required: ["chatGuid", "media"],
      properties: {
        chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
        media: { type: "string", format: "binary", description: "JPEG, PNG, HEIC/HEIF, QuickTime MOV, or MP4 media." },
        title: stringProperty("Optional public iCloud album title."),
        caption: stringProperty("Primary Photos card caption."),
        subcaption: stringProperty("Secondary Photos card caption."),
        ldText: stringProperty("Accessibility and link-description text for the card."),
      },
    },
  },
  "GET /api/v1/iblue/poll/:messageGuid": {
    summary: "Get a poll and its votes",
    description: "Returns a normalized Messages poll, its stable option identifiers, and every observed participant vote.",
    tags: ["iBlue Polls"],
  },
  "POST /api/v1/iblue/poll": {
    summary: "Send a poll",
    description: "Creates a native Messages poll with two to 32 options and returns its sent-message representation.",
    tags: ["iBlue Polls"],
    body: {
      type: "object",
      required: ["chatGuid", "options"],
      properties: {
        chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
        title: stringProperty("Optional question or title shown above the choices."),
        options: {
          type: "array",
          description: "Choice labels in display order.",
          minItems: 2,
          maxItems: 32,
          items: { type: "string", minLength: 1 },
        },
      },
    },
  },
  "POST /api/v1/iblue/poll/:messageGuid/vote": {
    summary: "Vote in a poll",
    description: "Replaces this profile's vote on an existing Messages poll with the selected option identifiers.",
    tags: ["iBlue Polls"],
    body: {
      type: "object",
      required: ["optionIdentifiers"],
      properties: {
        optionIdentifiers: stringArrayProperty("Stable identifiers of the selected poll options.", { minItems: 1 }),
      },
    },
  },
  "POST /api/v1/iblue/location/query": {
    summary: "Query shared-location messages",
    description: "Lists normalized static map pins and live Find My sharing records with optional chat, time, and pagination filters.",
    tags: ["iBlue Locations"],
    body: {
      type: "object",
      properties: {
        chatGuid: stringProperty("Limit results to this BlueBubbles chat GUID."),
        after: { type: "integer", description: "Minimum Unix timestamp in milliseconds." },
        before: { type: "integer", description: "Maximum Unix timestamp in milliseconds." },
        ...paginationProperties,
      },
    },
  },
  "GET /api/v1/iblue/location/live": {
    summary: "Refresh live Find My locations",
    description: "Refreshes indefinite Find My sharing state and returns the newest available coordinates for all peers or one address.",
    tags: ["iBlue Locations"],
    querystring: {
      type: "object",
      properties: { address: stringProperty("Optional Messages address to refresh.") },
    },
  },
  "GET /api/v1/iblue/location/:messageGuid": {
    summary: "Get normalized shared-location data",
    description: "Returns normalized coordinates and metadata for one static pin or live-location sharing message.",
    tags: ["iBlue Locations"],
  },
};

function contactCardFieldSchema(): JsonSchema {
  return {
    type: "object",
    description: "Labeled contact value.",
    additionalProperties: false,
    required: ["value"],
    properties: {
      value: { type: "string", minLength: 1, description: "Phone number, email address, URL, or profile value." },
      label: stringProperty("Human-readable label such as mobile, work, or home."),
      types: stringArrayProperty("vCard type tokens such as CELL, WORK, or HOME."),
      preferred: booleanProperty("Whether this is the preferred value of its kind."),
    },
  };
}

function textRunSchema(): JsonSchema {
  return {
    type: "object",
    description: "Formatting and animation applied to one UTF-16 text range.",
    additionalProperties: false,
    required: ["range"],
    properties: {
      range: {
        type: "array",
        description: "Two integers: UTF-16 start offset followed by UTF-16 length.",
        minItems: 2,
        maxItems: 2,
        prefixItems: [
          integerProperty("Zero-based UTF-16 start offset.", { minimum: 0 }),
          integerProperty("Number of UTF-16 code units in the run.", { minimum: 1 }),
        ],
      },
      styles: {
        type: "array",
        description: "Static styles to combine on this range.",
        uniqueItems: true,
        items: { type: "string", enum: ["bold", "italic", "underline", "strikethrough"] },
      },
      effect: {
        type: "string",
        description: "Apple inline text animation for this range.",
        enum: ["big", "small", "shake", "nod", "explode", "ripple", "bloom", "jitter"],
      },
    },
  };
}

function messageCountQuerySchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      ...messageTimeQueryProperties,
      minRowId: integerProperty("Count messages whose local database row ID is at least this value.", { minimum: 0 }),
      maxRowId: integerProperty("Count messages whose local database row ID is at most this value.", { minimum: 0 }),
    },
  };
}

function messageListQuerySchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      ...paginationProperties,
      after: messageTimeQueryProperties.after,
      before: messageTimeQueryProperties.before,
      sort: {
        type: "string",
        enum: ["ASC", "DESC"],
        default: "DESC",
        description: "Creation-time sort direction.",
      },
    },
  };
}

function participantRouteDocumentation(summary: string, description: string): FastifySchema {
  return {
    summary,
    description,
    tags: ["Chats"],
    body: {
      type: "object",
      required: ["address"],
      properties: {
        address: stringProperty("Phone number or email address of the participant to add or remove."),
      },
    },
  };
}

function messageQueryBodySchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      ...paginationProperties,
      ...messageTimeQueryProperties,
      sort: {
        type: "string",
        enum: ["ASC", "DESC"],
        default: "DESC",
        description: "Creation-time sort direction.",
      },
      where: {
        type: "array",
        description: "BlueBubbles-compatible row-ID conditions. iBlue recognizes message.ROWID > :startRowId and message.ROWID <= :endRowId (originalRowId is also accepted).",
        items: {
          type: "object",
          description: "One BlueBubbles query condition.",
          properties: {
            statement: stringProperty("BlueBubbles SQL-style condition using :startRowId or :endRowId."),
            args: {
              type: "object",
              description: "Named row-ID values referenced by statement.",
              additionalProperties: false,
              properties: {
                startRowId: integerProperty("Exclusive lower local row-ID bound.", { minimum: 0 }),
                endRowId: integerProperty("Inclusive upper local row-ID bound.", { minimum: 0 }),
              },
            },
          },
        },
      },
    },
  };
}

function editRouteDocumentation(messageGuidInBody: boolean): FastifySchema {
  return {
    summary: "Edit a sent message",
    description: messageGuidInBody
      ? "Edits text previously sent by this iBlue profile; the target GUID is supplied in the request body."
      : "Edits text previously sent by this iBlue profile; the target GUID is supplied in the path.",
    tags: ["Messages"],
    body: {
      type: "object",
      additionalProperties: false,
      required: messageGuidInBody ? ["messageGuid", "editedMessage"] : ["editedMessage"],
      properties: {
        ...(messageGuidInBody
          ? { messageGuid: stringProperty("GUID of the previously sent message to edit.") }
          : {}),
        editedMessage: stringProperty("Replacement plain-text body."),
        partIndex: integerProperty("Zero-based part index to replace within the message.", { minimum: 0, default: 0 }),
      },
    },
  };
}

function unsendRouteDocumentation(messageGuidInBody: boolean): FastifySchema {
  return {
    summary: "Unsend a sent message",
    description: messageGuidInBody
      ? "Retracts a message previously sent by this iBlue profile; the target GUID is supplied in the request body."
      : "Retracts a message previously sent by this iBlue profile; the target GUID is supplied in the path.",
    tags: ["Messages"],
    body: {
      type: "object",
      additionalProperties: false,
      required: messageGuidInBody ? ["messageGuid"] : [],
      properties: {
        ...(messageGuidInBody
          ? { messageGuid: stringProperty("GUID of the previously sent message to retract.") }
          : {}),
        partIndex: integerProperty("Zero-based part index to retract within the message.", { minimum: 0, default: 0 }),
      },
    },
  };
}

function attachmentMessageBodySchema(): JsonSchema {
  return {
    type: "object",
    required: ["chatGuid", "attachment"],
    properties: {
      chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
      attachment: { type: "string", format: "binary", description: "File bytes to upload and send." },
      name: stringProperty("Optional recipient-visible filename; defaults to the uploaded filename."),
      tempGuid: stringProperty("Optional client-generated correlation GUID."),
      subject: stringProperty("Optional iMessage attachment caption/subject."),
      ...messageEffectProperties,
      isAudioMessage: booleanProperty("Mark the upload as an expiring iMessage audio message."),
      selectedMessageGuid: stringProperty("GUID of the message being replied to."),
      partIndex: integerProperty("Zero-based part index within the replied-to message.", { minimum: 0, default: 0 }),
    },
  };
}

function multipartMessageBodySchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["chatGuid", "parts"],
    properties: {
      chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
      parts: {
        type: "array",
        description: "Ordered text, mention, and staged-attachment parts.",
        minItems: 1,
        items: {
          type: "object",
          description: "One message part. Supply text or both attachment and name.",
          additionalProperties: false,
          required: ["partIndex"],
          properties: {
            partIndex: integerProperty("Zero-based output position for this part.", { minimum: 0 }),
            text: stringProperty("Plain text for a text or mention part."),
            mention: stringProperty("Messages address mentioned by this text part."),
            attachment: stringProperty("Staged path returned by POST /api/v1/attachment/upload."),
            name: stringProperty("Recipient-visible filename required for an attachment part."),
          },
        },
      },
      tempGuid: stringProperty("Optional client-generated correlation GUID."),
      subject: stringProperty("Optional iMessage subject line."),
      ...messageEffectProperties,
      ...replyProperties,
      ddScan: booleanProperty("Ask Messages to scan text for Data Detectors such as dates and addresses."),
    },
  };
}

function operationId(method: string, url: string): string {
  const path = url
    .replace(/^\/api\/v1\/?/, "")
    .replace(/:([A-Za-z0-9_]+)/g, "by_$1")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `${method.toLowerCase()}_${path || "root"}`;
}

function inferredPathParameter(url: string, name: string): JsonSchema {
  if (name === "variant") {
    return {
      type: "string",
      enum: ["original", "medium", "thumbnail"],
      description: "Media rendition to download from the iCloud Photos share.",
    };
  }
  if (name === "id") {
    return integerProperty("Numeric resource ID.", { minimum: 1 });
  }
  if (name === "address") {
    return stringProperty("URL-encoded Messages phone number or email address.");
  }
  if (name === "attachmentGuid") {
    return stringProperty("GUID of the stored iMessage attachment.");
  }
  if (name === "itemGuid") {
    return stringProperty("Identifier of one asset within the resolved iCloud Photos share.");
  }
  if (name === "messageGuid") {
    return stringProperty("GUID of the target iMessage.");
  }
  if (name === "guid") {
    if (url.startsWith("/api/v1/chat/")) return stringProperty("BlueBubbles chat GUID.");
    if (url.startsWith("/api/v1/handle/")) return stringProperty("Messages handle GUID or normalized address.");
    if (url.startsWith("/api/v1/attachment/")) return stringProperty("GUID of the stored iMessage attachment.");
    return stringProperty("GUID of the target iMessage.");
  }
  return stringProperty(`Path identifier named ${name}.`);
}

function inferredParams(url: string): JsonSchema | undefined {
  const names = [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);
  if (names.length === 0) return undefined;
  return {
    type: "object",
    required: names,
    properties: Object.fromEntries(names.map((name) => [name, inferredPathParameter(url, name)])),
  };
}

export function documentApiRoute(
  schema: FastifySchema | undefined,
  url: string,
  routeMethod: HTTPMethods | HTTPMethods[],
): FastifySchema {
  const source = schema ?? {};
  if (!url.startsWith("/api/v1/")) return { ...source, hide: true };
  if (url === "/api/v1/*") return { ...source, hide: true };

  const method = (Array.isArray(routeMethod) ? routeMethod[0] ?? "GET" : routeMethod).toUpperCase();
  const key = `${method} ${url}`;
  const documented = routeDocumentation[key];
  if (!documented?.summary || !documented.description || !documented.tags) {
    throw new Error(`OpenAPI documentation is incomplete for ${key}`);
  }
  const params = source.params ?? documented.params ?? inferredParams(url);

  return {
    ...source,
    ...documented,
    tags: source.tags ?? documented.tags,
    summary: source.summary ?? documented.summary,
    description: source.description ?? documented.description,
    operationId: source.operationId ?? documented.operationId ?? operationId(method, url),
    ...(params ? { params } : {}),
  };
}

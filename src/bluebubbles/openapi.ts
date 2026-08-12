import type { FastifySchema, HTTPMethods } from "fastify";

import { PINNED_BLUEBUBBLES_REST_ROUTES } from "./compatibility-routes.js";
import { IBLUE_BUILTIN_CONVERSATION_BACKGROUNDS } from "./backgrounds.js";

type JsonSchema = Record<string, unknown>;

const stringProperty = (description: string): JsonSchema => ({ type: "string", description });
const paginationProperties = {
  offset: { type: "integer", minimum: 0, default: 0 },
  limit: { type: "integer", minimum: 1, default: 100 },
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

const routeDocumentation: Record<string, FastifySchema> = {
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
    tags: ["iBlue Contacts"],
    body: {
      type: "object",
      properties: {
        addresses: { type: "array", items: { type: "string" } },
        search: { type: "string" },
        sources: {
          type: "array",
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
    tags: ["iBlue Focus"],
    body: {
      type: "object",
      required: ["handles"],
      properties: {
        handles: { type: "array", minItems: 1, maxItems: 256, items: { type: "string" } },
      },
    },
  },
  "POST /api/v1/iblue/focus/share": {
    summary: "Publish this account's Focus status",
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
    tags: ["iBlue Contacts"],
  },
  "PUT /api/v1/iblue/contact/vcf": {
    summary: "Import a profile VCF",
    tags: ["iBlue Contacts"],
    body: {
      type: "object",
      required: ["vcf"],
      properties: { vcf: stringProperty("Complete vCard text to import.") },
    },
  },
  "GET /api/v1/iblue/contact/:address/avatar": {
    summary: "Download a contact avatar",
    tags: ["iBlue Contacts"],
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
        type: { type: "string", enum: ["delivered", "read"] },
        handle: stringProperty("Optionally filter by recipient address."),
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
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
        message: { type: "string" },
        attributedBody: { type: "string", description: "Advanced semantic HTML input." },
        textRuns: {
          type: "array",
          description: "Sorted, non-overlapping NSRange-compatible runs measured in UTF-16 code units.",
          items: {
            type: "object",
            required: ["range"],
            properties: {
              range: {
                type: "array",
                minItems: 2,
                maxItems: 2,
                prefixItems: [
                  { type: "integer", minimum: 0 },
                  { type: "integer", minimum: 1 },
                ],
              },
              styles: {
                type: "array",
                uniqueItems: true,
                items: { type: "string", enum: ["bold", "italic", "underline", "strikethrough"] },
              },
              effect: {
                type: "string",
                enum: ["big", "small", "shake", "nod", "explode", "ripple", "bloom", "jitter"],
              },
            },
          },
        },
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
        partIndex: { type: "integer", minimum: 0, default: 0 },
        reaction: {
          type: "string",
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
        partIndex: { type: "integer", minimum: 0, default: 0 },
        source: { type: "string", enum: ["sticker", "memoji", "genmoji"], default: "sticker" },
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
        scale: { type: "number", minimum: 0.05, maximum: 2 },
      },
    },
  },
  "POST /api/v1/iblue/rich-link": {
    summary: "Send a rich link or Apple Music card",
    tags: ["iBlue Messages"],
    body: {
      type: "object",
      required: ["chatGuid", "originalUrl"],
      additionalProperties: true,
      properties: {
        chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
        originalUrl: { type: "string", format: "uri" },
        url: { type: "string", format: "uri" },
        title: { type: "string" },
        summary: { type: "string" },
        artworkAttachmentGuid: { type: "string" },
        appleMusic: {
          type: "object",
          description: "Optional Apple Music playback metadata.",
          additionalProperties: true,
        },
      },
    },
  },
  "POST /api/v1/iblue/message/component": {
    summary: "Send a generic iMessage component envelope",
    description: "Sends a normalized MSMessageTemplateLayout balloon without exposing keyed-archive internals.",
    tags: ["iBlue Messages"],
    body: {
      type: "object",
      required: ["chatGuid", "bundleId", "url"],
      additionalProperties: false,
      properties: {
        chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
        bundleId: { type: "string", maxLength: 512 },
        appName: { type: "string" },
        appId: { type: "integer", minimum: 0 },
        url: { type: "string", maxLength: 16384 },
        sessionId: { type: "string", format: "uuid" },
        isLive: { type: "boolean" },
        ldText: { type: "string" },
        imageTitle: { type: "string" },
        imageSubtitle: { type: "string" },
        caption: { type: "string" },
        subcaption: { type: "string" },
        secondarySubcaption: { type: "string" },
        tertiarySubcaption: { type: "string" },
        iconAttachmentGuid: { type: "string" },
        text: { type: "string" },
        subject: { type: "string" },
        replyGuid: { type: "string" },
        replyPart: { type: "string" },
      },
    },
  },
  "GET /api/v1/iblue/chat/:guid/background": {
    summary: "Get a conversation background",
    tags: ["iBlue Messages"],
  },
  "GET /api/v1/iblue/background/presets": {
    summary: "List built-in animated conversation backgrounds",
    description: "Lists every Apple DynamicBackgroundPosterExtension preset accepted by the background endpoint.",
    tags: ["iBlue Messages"],
  },
  "POST /api/v1/iblue/chat/:guid/background": {
    summary: "Set or remove a conversation background",
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
        remove: { type: "boolean" },
      },
    },
  },
  "POST /api/v1/iblue/cloud/messages/chats/sync": {
    summary: "Sync a Messages in iCloud chat page",
    tags: ["iBlue Cloud Sync"],
    body: cloudSyncBody,
  },
  "POST /api/v1/iblue/cloud/messages/messages/sync": {
    summary: "Sync a Messages in iCloud message page",
    tags: ["iBlue Cloud Sync"],
    body: cloudSyncBody,
  },
  "POST /api/v1/iblue/cloud/messages/attachments/sync": {
    summary: "Sync a Messages in iCloud attachment-metadata page",
    tags: ["iBlue Cloud Sync"],
    body: cloudSyncBody,
  },
  "GET /api/v1/iblue/icloud-share/:messageGuid": {
    summary: "Resolve an iCloud Photos share",
    tags: ["iBlue iCloud Photos"],
  },
  "GET /api/v1/iblue/icloud-share/:messageGuid/item/:itemGuid/:variant": {
    summary: "Download shared iCloud media",
    description: "Variant must be original, medium, or thumbnail.",
    tags: ["iBlue iCloud Photos"],
  },
  "POST /api/v1/iblue/icloud-share": {
    summary: "Send an existing iCloud Photos share",
    tags: ["iBlue iCloud Photos"],
    body: {
      type: "object",
      required: ["chatGuid", "url"],
      properties: {
        chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
        url: { type: "string", format: "uri" },
        caption: { type: "string" },
        subcaption: { type: "string" },
        ldText: { type: "string" },
      },
    },
  },
  "POST /api/v1/iblue/icloud-share/create": {
    summary: "Create and send a fresh iCloud Photos share",
    description: "Uploads one Photos-compatible image or video to the opted-in iCloud web session, creates a fresh public share, waits for anonymous access, and sends its native Photos Messages card.",
    tags: ["iBlue iCloud Photos"],
    consumes: ["multipart/form-data"],
    body: {
      type: "object",
      required: ["chatGuid", "media"],
      properties: {
        chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
        media: { type: "string", format: "binary", description: "JPEG, PNG, GIF, HEIC/HEIF, MOV, or MP4 media." },
        title: { type: "string" },
        caption: { type: "string" },
        subcaption: { type: "string" },
        ldText: { type: "string" },
      },
    },
  },
  "GET /api/v1/iblue/poll/:messageGuid": {
    summary: "Get a poll and its votes",
    tags: ["iBlue Polls"],
  },
  "POST /api/v1/iblue/poll": {
    summary: "Send a poll",
    tags: ["iBlue Polls"],
    body: {
      type: "object",
      required: ["chatGuid", "options"],
      properties: {
        chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
        title: { type: "string" },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 32,
          items: { type: "string", minLength: 1 },
        },
      },
    },
  },
  "POST /api/v1/iblue/poll/:messageGuid/vote": {
    summary: "Vote in a poll",
    tags: ["iBlue Polls"],
    body: {
      type: "object",
      required: ["optionIdentifiers"],
      properties: {
        optionIdentifiers: { type: "array", items: { type: "string" } },
      },
    },
  },
  "POST /api/v1/iblue/location/query": {
    summary: "Query shared-location messages",
    tags: ["iBlue Locations"],
    body: {
      type: "object",
      properties: {
        chatGuid: { type: "string" },
        after: { type: "integer", description: "Minimum Unix timestamp in milliseconds." },
        before: { type: "integer", description: "Maximum Unix timestamp in milliseconds." },
        ...paginationProperties,
      },
    },
  },
  "GET /api/v1/iblue/location/live": {
    summary: "Refresh live Find My locations",
    tags: ["iBlue Locations"],
    querystring: {
      type: "object",
      properties: { address: stringProperty("Optional Messages address to refresh.") },
    },
  },
  "GET /api/v1/iblue/location/:messageGuid": {
    summary: "Get normalized shared-location data",
    tags: ["iBlue Locations"],
  },
};

const genericJsonBody: JsonSchema = {
  type: "object",
  additionalProperties: true,
  description: "See the BlueBubbles API contract for accepted fields.",
};

function routeTag(url: string): string {
  if (url.startsWith("/api/v1/iblue/")) return "iBlue Extensions";
  const resource = url.split("/")[3] ?? "server";
  return {
    attachment: "Attachments",
    chat: "Chats",
    contact: "Contacts",
    fcm: "FCM",
    handle: "Handles",
    message: "Messages",
    server: "Server",
    webhook: "Webhooks",
  }[resource] ?? "BlueBubbles Compatibility";
}

function operationId(method: string, url: string): string {
  const path = url
    .replace(/^\/api\/v1\/?/, "")
    .replace(/:([A-Za-z0-9_]+)/g, "by_$1")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `${method.toLowerCase()}_${path || "root"}`;
}

function inferredParams(url: string): JsonSchema | undefined {
  const names = [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);
  if (names.length === 0) return undefined;
  return {
    type: "object",
    required: names,
    properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
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
  const documented = routeDocumentation[`${method} ${url}`] ?? {};
  const params = source.params ?? documented.params ?? inferredParams(url);
  const acceptsJsonBody = ["POST", "PUT", "PATCH"].includes(method);

  return {
    ...source,
    ...documented,
    tags: source.tags ?? documented.tags ?? [routeTag(url)],
    summary: source.summary ?? documented.summary ?? `${method} ${url}`,
    operationId: source.operationId ?? documented.operationId ?? operationId(method, url),
    ...(params ? { params } : {}),
    ...(source.body || documented.body || !acceptsJsonBody
      ? {}
      : { body: genericJsonBody }),
  };
}

export function completeOpenApiDocument<T extends { paths?: Record<string, unknown> }>(document: T): T {
  const paths = (document.paths ?? {}) as Record<string, Record<string, unknown>>;
  document.paths = paths;

  for (const route of PINNED_BLUEBUBBLES_REST_ROUTES) {
    const method = route.method.toLowerCase();
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const pathItem = paths[path] ?? {};
    paths[path] = pathItem;
    if (pathItem[method]) continue;

    const params = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
      name: match[1]!,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    const acceptsBody = ["post", "put", "patch"].includes(method);
    pathItem[method] = {
      operationId: operationId(route.method, route.path),
      summary: `${route.method} ${route.path}`,
      description: "Recognized for BlueBubbles 1.9.9 compatibility. This operation currently returns an authenticated BlueBubbles-shaped 501 response because it requires a macOS app or administration subsystem outside iBlue's isolated IDS service.",
      tags: [routeTag(route.path)],
      ...(params.length > 0 ? { parameters: params } : {}),
      ...(acceptsBody
        ? {
          requestBody: {
            required: false,
            content: { "application/json": { schema: genericJsonBody } },
          },
        }
        : {}),
      responses: {
        "501": {
          description: "Recognized but unsupported by the isolated iBlue service.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["status", "message", "error"],
                properties: {
                  status: { type: "integer", const: 501 },
                  message: { type: "string" },
                  error: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
      },
    };
  }

  return document;
}

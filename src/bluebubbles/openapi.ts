import type { FastifySchema, HTTPMethods } from "fastify";

import { PINNED_BLUEBUBBLES_REST_ROUTES } from "./compatibility-routes.js";

type JsonSchema = Record<string, unknown>;

const stringProperty = (description: string): JsonSchema => ({ type: "string", description });
const paginationProperties = {
  offset: { type: "integer", minimum: 0, default: 0 },
  limit: { type: "integer", minimum: 1, default: 100 },
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
    description: "Searches contacts learned from profile VCF imports and Name & Photo Sharing.",
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
          items: { type: "string", enum: ["profile-vcf", "name-and-photo-sharing"] },
        },
        ...paginationProperties,
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
    description: "Uploads one JPEG to the opted-in iCloud web session, creates a fresh public share, waits for anonymous access, and sends its native Photos Messages card.",
    tags: ["iBlue iCloud Photos"],
    consumes: ["multipart/form-data"],
    body: {
      type: "object",
      required: ["chatGuid", "photo"],
      properties: {
        chatGuid: stringProperty("Destination BlueBubbles chat GUID."),
        photo: { type: "string", format: "binary", description: "JPEG image." },
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

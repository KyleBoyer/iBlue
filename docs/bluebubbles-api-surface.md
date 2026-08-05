# BlueBubbles API surface audit

The compatibility reference is
[`BlueBubblesApp/bluebubbles-server@f2e2286`](https://github.com/BlueBubblesApp/bluebubbles-server/tree/f2e2286241a7c3b6617a82b37d4afaab4df3a6b9),
the same commit reported by iBlue server metadata. Its route definitions are in
[`httpRoutes.ts`](https://github.com/BlueBubblesApp/bluebubbles-server/blob/f2e2286241a7c3b6617a82b37d4afaab4df3a6b9/packages/server/src/server/api/http/api/v1/httpRoutes.ts)
and
[`socketRoutes.ts`](https://github.com/BlueBubblesApp/bluebubbles-server/blob/f2e2286241a7c3b6617a82b37d4afaab4df3a6b9/packages/server/src/server/api/http/api/v1/socketRoutes.ts).

The inventory is extracted from the TypeScript syntax tree rather than from API
documentation or client call guesses.

The extracted inventory is also checked into
`test/fixtures/bluebubbles-rest-routes.ts` as a regression oracle. The local
contract suite now exercises all 91 pinned REST method/path pairs and asserts
that each returns a BlueBubbles `{status,...}` envelope rather than Fastify's
generic route-missing response. It also invokes all 33 pinned Socket.IO request
events with acknowledgements and fails on a timeout, a missing numeric status,
or a non-wire-compatible `encrypted` marker. The 34th socket event,
`disconnect`, remains the lifecycle handler.

On 2026-08-03 the upstream `master` ref was rechecked and still pointed to the
same `f2e2286241a7c3b6617a82b37d4afaab4df3a6b9` commit. The pinned contract is
therefore also the current BlueBubbles server contract; there is no newer REST
or Socket.IO surface being hidden by the compatibility version.

## Current result

| Surface | Pinned BlueBubbles | iBlue behavior |
| --- | ---: | --- |
| REST method/path pairs | 91 | 59 are native, 2 return exact neutral/absence responses used by the stock client, and the remaining 30 are authenticated by the same middleware and return a BlueBubbles-shaped `501`, never an HTML `404`. |
| Socket.IO handlers | 34 | All 33 client request events plus the `disconnect` lifecycle handler are registered. Core messaging events are native, profile-local VCF/config reads return valid responses, and four server/FCM administration events return an acknowledgement or named `error` with structured `501`; no known request is left hanging. |
| Realtime delivery events | BlueBubbles names | Native events include `new-message`, `updated-message`, `message-send-error`, typing/read changes, group participant/name/icon changes, and `imessage-aliases-removed`. |

The exact REST implementations cover:

- ping, server metadata, aggregate/media statistics;
- chat/message/handle/attachment counts and queries;
- direct and group chat creation;
- text, attachment, multipart, reaction, reply, edit, unsend, and Notify
  Anyway entry points, including subject/effect/audio flags used by the stock
  client's private-API send mode;
- typing, read, and unread controls;
- inbound typing start/stop plus per-message delivered/read update events;
- group name, participant, leave, and icon controls;
- local chat/message deletion;
- durable profile-local one-time and recurring message scheduling, including
  create/read/update/delete and scheduled-message realtime events;
- attachment metadata, download, force-download alias, and stored embedded
  media;
- empty isolated contact reads plus profile-local Socket.IO VCF storage;
- webhook create/list/delete; and
- FaceTime availability as an explicit `false` capability result.

Account alias removals are eligible for both Socket.IO and webhook delivery.
Incoming APNs envelope IDs are durably claimed before event conversion. A
completed claim suppresses stored-message/reconnect replay across restarts; a
claim left incomplete by a crash is reclaimed by the next process, avoiding a
permanent message-loss tombstone.
Webhook payloads keep the official `{type,data}` body. iBlue additionally uses
a profile-local durable outbox: jobs survive restart, remain ordered per
endpoint, and retry transient network or non-2xx failures. Delivery is
at-least-once because a process can exit after the receiver accepts a request
but before SQLite records success. Receivers can deduplicate using the stable
`X-iBlue-Webhook-Delivery-Id` header; exhausted jobs remain as profile-local
dead letters and are reported in service logs.
Server metadata likewise exposes `detected_imessage` as a bare address, while
the canonical IDS transport form remains internal to the profile.
BlueBubbles 1.9.9's webhook picker uses singular
`imessage-alias-removed` even though its emitted event constant is plural
`imessage-aliases-removed`; iBlue accepts either subscription spelling and
delivers the canonical plural event.
The full official 1.9.9 webhook-picker vocabulary is accepted, including
optional server-update, Find My, FaceTime, and backup events. Accepting a
subscription does not claim that an unsupported subsystem will emit it.

Two additional exact routes deliberately report an absent optional capability:

- `GET /fcm/client` returns BlueBubbles' own missing-Google-services `404`, so
  stock clients use Socket.IO without mistaking the connection for a failure;
- `GET /server/update/check` reports no BlueBubbles Electron update because
  iBlue has an independent release lifecycle.

The stock-client connection and first-sync path is traced separately in the
[official client bootstrap audit](bluebubbles-client-bootstrap.md).

The published BlueBubbles client tag
[`v2.0.0+89`](https://github.com/BlueBubblesApp/bluebubbles-app/tree/2d2ed90781885945f84d09812f760062ec7ca07b)
was rechecked against the pinned client. Its `lib/services/network/api` and
Socket.IO request/event contracts are unchanged, so it introduces no additional
mandatory iBlue route. The one selected-network diff is internal HTTP-service
plumbing.

## Structured `501` REST groups

The 30 exact BlueBubbles routes not implemented natively or as honest neutral
capability responses are deliberately
grouped rather than disguised as successful operations:

| Group | Routes | Why |
| --- | ---: | --- |
| macOS host control | 2 | iBlue does not control Messages.app or lock the host. |
| iCloud account/Find My | 7 | Separate Apple services, outside the iMessage transport goal. |
| Server logs/restart/update/alerts | 6 | Electron BlueBubbles server administration does not map to the direct IDS API; the read-only update check has a neutral response. |
| FCM | 1 | iBlue supplies Socket.IO and webhooks instead of Firebase; device registration is unsupported while the config read reports the normal missing-config response. |
| Blurhash/live-photo derivatives | 2 | The original attachment remains downloadable; no image derivative or paired live-video file is currently stored. |
| Share contact | 1 | BlueBubbles asks Messages.app to share its signed-in user's personal card. iBlue has no equivalent main-user contact identity and does not infer one from the profile VCF. |
| Focus status | 1 | StatusKit exists below the wrapper but is not exposed on the BlueBubbles API. |
| FaceTime sessions | 3 | FaceTime call control is not part of the current iBlue API. |
| Contact creation | 1 | iBlue must not mutate the main macOS user's Contacts database. |
| Theme/settings backup | 6 | BlueBubbles client/server administration, not iMessage transport. |

## Socket.IO parity

Every one of the 33 request names in the pinned server is registered. The four deliberately
unsupported mutations are:

- `add-fcm-device`;
- `change-proxy-service`;
- `restart-messages-app`; and
- `restart-private-api`.

They return a callback response when the caller supplies an acknowledgement
function, or emit `error` otherwise. This matters because Socket.IO has no
automatic "unknown method" response: omitting a handler causes a stock client
or integration to wait until its own timeout.

`get-server-config`, `get-fcm-client`, `get-logs`, `save-vcf`, `get-vcf`,
`get-contacts-from-vcf`, and `check-for-server-update` return honest local
capability/configuration data. VCF content is stored inside the iBlue profile;
iBlue never reads the signed-in macOS user's Contacts database.

## Compatibility boundary

An exact route name is not claimed as feature support merely because the
authenticated fallback returns JSON. The public compatibility contract and
this audit distinguish native behavior, neutral capability responses, and
structured `501`. The remaining work for the requested messaging replacement
is live Apple delivery verification, not Electron server-administration parity.

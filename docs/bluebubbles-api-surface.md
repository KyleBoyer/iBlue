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
  client's private-API send mode. Edit and unsend are also reachable as
  `POST /api/v1/message/edit` and `POST /api/v1/message/delete`, which take the
  target as a `messageGuid` body field instead of a path parameter. Those two
  paths are outside the pinned 1.9.9 route table above; they exist because
  third-party BlueBubbles clients send that spelling, and they share the pinned
  routes' handler;
- typing, read, and unread controls;
- inbound typing start/stop plus per-message delivered/read update events;
- group name, participant, leave, and icon controls;
- local chat/message deletion;
- durable profile-local one-time and recurring message scheduling, including
  create/read/update/delete and scheduled-message realtime events;
- attachment metadata, download, force-download alias, and stored embedded
  media;
- empty isolated BlueBubbles contact reads plus profile-local Socket.IO VCF
  storage and the additive iBlue contact/location API described below;
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

## Additive iBlue contact, location, poll, rich-link, message-flair, and audio metadata API

iBlue exposes normalized data that is useful to non-stock clients without
changing the pinned BlueBubbles contract. Every route uses the same
`?password=` authentication and `{status,message,data,metadata}` envelope as
the rest of `/api/v1`:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/iblue/contact` | List or search contacts with `address`, `displayName`, component names, source, avatar availability, and update time. |
| `POST` | `/api/v1/iblue/contact/query` | Query contacts by `addresses`, `search`, `sources`, `offset`, and `limit`. |
| `GET` / `PUT` | `/api/v1/iblue/contact/vcf` | Read or replace the profile-local VCF and its normalized contact index. |
| `GET` | `/api/v1/iblue/contact/:address/avatar` | Download the best available profile-local avatar. |
| `POST` | `/api/v1/iblue/location/query` | Query immutable location snapshots and static Apple Maps pins by chat and timestamp. |
| `GET` | `/api/v1/iblue/location/live?address=...` | Refresh Find My and return the current position for active location shares, optionally filtered to one phone number or email address. |
| `GET` | `/api/v1/iblue/location/:messageGuid` | Fetch the normalized snapshot or pin associated with one message. |
| `GET` | `/api/v1/iblue/message/flair` | List friendly message-flair names, display labels, categories, and their exact Apple effect identifiers. |
| `GET` | `/api/v1/iblue/poll/:messageGuid` | Fetch an Apple Messages poll definition plus its aggregated current votes. |
| `POST` | `/api/v1/iblue/poll/:messageGuid/vote` | Replace the sending profile's complete selection set using `{optionIdentifiers: string[]}`; an empty array clears its votes. |

Handles gain an optional `iBlue.contact` summary. Messages gain optional
`iBlue.senderContact`, `iBlue.sharedLocation`, `iBlue.messageFlair`,
`iBlue.audioTranscription`, `iBlue.richLink`, `iBlue.poll`, and `iBlue.pollVote` properties; Maps extension
messages also expose their real bundle identifier through BlueBubbles'
existing `balloonBundleId` field. An incoming iMessage Name & Photo Sharing
update emits the additive `iblue-contact-updated` Socket.IO/webhook event.

Apple URL previews expose their URL, title, summary, and artwork reference as
`iBlue.richLink`. Apple Music links additionally expose the storefront,
resource type, catalog identifier, and album/song identifiers when present.
The internal `x-richlink/meta` transport record is not returned as a user
attachment. Preview artwork remains a normal authenticated attachment with its
real image MIME type and an `iBlueRichLinkArtwork` metadata marker, so callers
can download the exact bytes Apple sent. REST, Socket.IO, and webhook message
objects share this representation.

`iBlue.messageFlair` normalizes Apple's opaque `expressiveSendStyleId` into
`name`, `displayName`, and `category` (`bubble` or `screen`) while retaining the
exact identifier in `effectId`. Unknown future identifiers are preserved with
`known: false`. Outbound text, attachment, multipart, scheduled, and Socket.IO
message requests may use the additive friendly `flair` string (for example,
`"confetti"` or `"invisible-ink"`) instead of BlueBubbles' raw `effectId`.
The raw field remains accepted unchanged, and supplying an unknown raw
`com.apple.*` identifier through `flair` is also allowed as a forward-compatible
escape hatch.

For a received audio message, `iBlue.audioTranscription` is present only when
Apple included the sender-side transcript in the iMessage attachment metadata.
Its shape is `{text, source: "apple"}`. iBlue does not run speech recognition
or synthesize a transcript. The original audio remains a normal BlueBubbles
attachment and is available from the authenticated attachment download route.
The same message object is used by REST queries, Socket.IO, and webhooks, so
those surfaces expose the Apple-provided transcript consistently.

Apple Messages Polls (“Choice” messages) are multi-select. The base message's
`iBlue.poll.options` retains Apple's stable option identifiers, and
`iBlue.poll.votes` aggregates the latest complete selection set sent by each
participant. Each acknowledgement message also exposes its raw normalized set
as `iBlue.pollVote`. Voting sends Apple Polls' extension acknowledgement rather
than a tapback; callers submit the entire desired option-identifier set so add,
remove, multi-select, and clear operations are deterministic.

The profile VCF has priority over a peer's shared name. An avatar may fall
back to Name & Photo Sharing when the matching VCF entry has no photo. Shared
location history records are derived from received iMessage app balloons and
plain Apple Maps URLs. Find My balloons preserve the initial location as an
immutable message snapshot, while Apple Maps links (including Dropped Pin
messages) are normalized to coordinates when present.

`GET /api/v1/iblue/location/live` is deliberately separate from message
history. Each request refreshes the profile's Find My Friends state using its
existing Apple session; supplying `address` also selects that share for a
second refresh so Apple can return its latest position. Responses include the
location timestamp, accuracy, expiry, active/old state, and any address fields
Apple returns. Clients may poll this additive endpoint to follow movement.
iBlue does not read Contacts.app or geocode coordinates itself.

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

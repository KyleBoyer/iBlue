# BlueBubbles compatibility contract

iBlue's public API targets the BlueBubbles Server wire contract. The reference is
`BlueBubblesApp/bluebubbles-server` commit
`f2e2286241a7c3b6617a82b37d4afaab4df3a6b9` (2026-07-18).

Compatibility means:

- REST routes live under `/api/v1`.
- Every protected route accepts the server password as the `password`, `guid`,
  or `token` query parameter.
- JSON uses BlueBubbles' `{status, message, data?, metadata?, error?}` envelope.
- Realtime clients use Socket.IO and authenticate with `password` or `guid` in
  the handshake query.
- Messaging events use BlueBubbles names and payloads, including `new-message`,
  `updated-message`, `message-send-error`, `typing-indicator`, and the group
  change events.
- Webhooks receive `{type, data}` and may subscribe to `*` or named events.

The exact pinned inventory is tracked in the
[API surface audit](bluebubbles-api-surface.md): 59 of 91 REST method/path
pairs have native handlers, 2 provide exact neutral/absence responses, every
other protected REST path fails immediately with the same structured `501`
envelope, and all 33 pinned Socket.IO request events (plus `disconnect`) are
registered so unsupported calls cannot hang indefinitely. The stock app's
actual setup, first-sync, and startup calls are traced in the
[official client bootstrap audit](bluebubbles-client-bootstrap.md).
These counts are executable contracts: tests issue all 91 REST pairs and all
33 acknowledgement-bearing Socket.IO requests from a fixture extracted from
the pinned upstream TypeScript source.

BlueBubbles' official client treats `server_version` as a strict semantic
version and uses it for feature gates. iBlue therefore reports the pinned wire
contract version (`1.9.9`) in that field and reports its own implementation
version separately as `data.iBlue.version`. `os_version` always contains at
least two numeric components because the client indexes both during setup. On
non-macOS hosts, its `15.0` value is an API-compatibility level rather than a
claim about the host; the actual platform and kernel release are available as
`data.iBlue.runtimePlatform` and `data.iBlue.runtimeRelease`.

## Compatibility levels

| Area | Level | Notes |
| --- | --- | --- |
| Ping and server metadata | Native | BlueBubbles response shape; metadata identifies iBlue and direct IDS mode. |
| Database statistics | Native | Chat count includes BB's `{total, breakdown}` shape; aggregate and per-chat media totals support BB's singular/plural `only` filter. |
| Send/receive text | Receive live-verified; send implemented | APNs text receive is verified without Messages.app. Text, subject, expressive effect, attributed body, and reply fields reach the raw IDS constructor. The new live test account currently gets zero IDS targets for outbound sends. |
| Send/receive attachments | Receive live-verified; send implemented | Live MMCS download, persistence, metadata, and the BB download route are verified. Both BB's direct `POST /message/attachment` form upload and its staged `POST /attachment/upload` flow are implemented; subject, effect, reply, and audio-message fields survive the API-to-IDS path. iMessage send now proves the exact IDS recipient/fanout set before uploading MMCS bytes, while SMS relay attachments remain inline as rustpush requires. Outbound MMCS delivery is not yet verified. |
| Multipart messages | Implemented, contract-tested; live pending | `POST /attachment/upload` returns BB's opaque `UUID/name` path. `POST /message/multipart` sends one ordered IDS message containing text, confirmed mentions, and one or more attachments, preserves `partIndex`, and returns the BB message envelope with `tempGuid`. iMessage multipart preflights all targets once before the first MMCS upload; SMS multipart uses inline relay attachments. |
| Send/receive tapbacks | Receive live-verified; send implemented | A live inbound `laugh` tapback was correlated to the image message GUID and emitted by webhook. A live 49,495-byte HEIC sticker was also correlated, persisted, emitted with BB's `associatedMessageType: "sticker"` and `isSticker: true`, and delivered through the attachment API. Outbound tapbacks now encode Apple's associated-message range in NSString/UTF-16 units rather than UTF-8 bytes, including the one-unit attachment placeholder and two-unit supplementary emoji. The test account's outbound attempt currently fails target lookup. |
| Edit and unsend | Implemented, live pending | Outbound routes and inbound BB update events map to IDS edit/unsend operations; no live round trip is claimed yet. |
| Typing and read state | Typing receive live-verified; remaining paths implemented | A live typing-start event reached the webhook. Native conversion now preserves explicit stop-typing as `display:false`. Peer delivery/read controls update the original outgoing message's `dateDelivered`/`dateRead` and emit `updated-message`; controls that race the send RPC are buffered until the outgoing `new-message` event is durable, and replayed controls are idempotent. Outbound typing, read, and BB's `POST /chat/:guid/unread` are implemented. Delivery/read round trips remain pending. |
| Notify Anyway | Implemented, contract-tested; live pending | BB's `POST /message/:guid/notify` maps to IDS command 113 and updates `didNotifyRecipient` on the existing message. |
| Scheduled messages | Native, contract-tested | All five BB schedule routes use the profile-local SQLite database. One-time and recurring jobs survive restart, execute through the same direct-IDS text path, and emit BB's created/updated/deleted/sent/error events to Socket.IO and webhooks. Passive IDS mode turns a due job into a local error without invoking the native send method. |
| Group rename, participants, leave, and icon | Implemented, contract-tested; live pending | BB's REST and Socket.IO names map to rustpush's direct IDS group controls. Participant changes send the complete target member list, group versions remain monotonic, and group icons are persisted profile-locally. Group leave sends IDS command 190 with the local sender intentionally omitted from the complete new participant list. |
| Message/chat query | Live-verified local history | Live text/image events are queryable from iBlue's profile-local database, not the signed-in macOS user's `chat.db`. BB 1.6+ incremental sync's bounded `message.ROWID` predicates are parsed into parameterized local queries. |
| Local deletion | Native, contract-tested | BB's chat and chat-message delete routes remove only iBlue profile history and downloaded files; they do not unsend a message or mutate Messages.app. |
| Contacts/VCF | Isolated neutral surface | REST contact reads return an empty contact book; Socket.IO VCF save/load is profile-local and never reads or writes the main macOS user's Contacts database. |
| FCM/update discovery | Exact neutral/absence surface | The stock client receives BlueBubbles' normal missing-Firebase `404` and continues with Socket.IO; the delayed server-update check reports no Electron update. FCM device registration and update installation remain structured `501`. |
| Socket.IO and webhooks | Webhook live-verified; durable retry and Socket.IO contract-tested | A live APNs text, typing event, image, and image-associated tapback reached a wildcard webhook. Webhook jobs are committed to the profile SQLite database before dispatch, survive restart, preserve order per endpoint, retry network/non-2xx failures with bounded exponential backoff, and retain exhausted jobs as dead letters. Completed APNs envelope IDs are claimed durably so stored-message/reconnect replay does not emit a second event; an incomplete claim is reclaimed by the next process after a crash. The JSON body remains BlueBubbles' `{type,data}` shape; `X-iBlue-Webhook-Delivery-Id` remains stable across retries so consumers can deduplicate at-least-once delivery. Socket.IO callback/named-response/chunk APIs are covered by local contract tests. |

The post-canary `outbound-verify` command exercises the actual localhost
BlueBubbles REST routes for the remaining outbound core, rather than calling
service internals. It journals every accepted operation and correlates
delivery/read/error controls through the REST message resource. The command is
implemented and contract-tested against a receipt-racing fake native transport;
its live Apple run remains gated on a delivered canonical canary.

Every newly received message carries
`iBlue.senderVerificationFailed`. A value of `true` means the IDS payload was
delivered and decrypted, but rustpush could not authenticate the sender
signature because Apple did not return the peer identity. Typing/read webhook
payloads carry the same field under `iBlue`; iBlue does not silently describe
such payloads as cryptographically verified.

When the server is started with `--ids-passive`, it intentionally skips inbound
sender-key directory lookups during an Apple rate-limit cooldown. Server info
reports `iBlue.idsMode: "passive"`, and received encrypted messages retain
`senderVerificationFailed: true`. All BlueBubbles event and attachment surfaces
continue operating. REST and Socket.IO outbound text, reaction, attachment,
availability, typing, read, edit/unsend, notification, and group-control
requests are rejected locally in passive mode before they can create Apple
traffic. Passive mode is not an outbound-routing bypass.

The standard attachment force-download route is supported as an alias for the
normal download route. Direct IDS receive has already completed MMCS download
before an attachment is exposed; absent local content therefore returns the
same structured not-found response instead of attempting a second Apple fetch.

The implemented group REST surface is `PUT /api/v1/chat/:guid`,
`POST|DELETE /api/v1/chat/:guid/participant`, `POST /api/v1/chat/:guid/leave`, the BB participant add/remove
aliases, and `GET|POST|DELETE /api/v1/chat/:guid/icon`. Socket.IO supports
`rename-group`, `add-participant`, and `remove-participant`, including BB's
named success/error events. Inbound IDS participant changes emit
`participant-added`, `participant-removed`, or `participant-left` with a BB
message payload containing the updated chat. These operations have been tested
against a fake native transport; Apple delivery remains intentionally untested
during the active IDS cooldown.

The leave wire shape is not a guess: the direct-IDS
[`OpenBubbles` implementation](https://github.com/stevesoltys/openbubbles/blob/6452ae3f10f6cfc09418ddd167cede1ce83982a5/lib/services/rustpush/rustpush_service.dart#L1008-L1041)
implements leave by removing its own active handle and sending the same
`ChangeParticipantMessage` used for ordinary participant changes. iBlue keeps
ordinary add/remove sender-preserving and exposes a separate native leave call
so only the explicit leave route can omit the local handle.

Mark-unread and Notify Anyway reuse the affected message GUID as the IDS control
envelope ID, matching commands 111 and 113 in the pinned rustpush transport.
Their inbound reflections update the existing chat/message and emit BB's
`chat-read-status-changed` or `updated-message` event; they do not create blank
message rows.

| Area | Level | Notes |
| --- | --- | --- |
| Existing Messages.app history | Unsupported by default | Reading the main user's `chat.db` would violate account isolation and would not represent the secondary account. |
| macOS control, FCM registration, Find My, FaceTime sessions, and themes/settings backup | Explicitly unsupported | These are separate Apple services or BlueBubbles server-administration features, not the implemented iMessage transport. Routes return a structured `501`; Socket.IO mutations acknowledge with the same structured error. |
| AppleScript/private-API method selector | Accepted, ignored | iBlue always uses its direct IDS engine. |

Synthetic database fields such as `originalROWID` are stable values from iBlue's
local SQLite store. Fields unavailable from IDS are returned with the same BB
type and a neutral value. An additive `iBlue` object records the source and any
important fidelity notes; clients that deserialize only known BB fields can
ignore it.

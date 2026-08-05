# Outbound iMessage wire audit

This audit records what iBlue can prove without making an Apple request. Live
delivery remains a separate gate while the secondary account's IDS directory
responses are empty.

| Operation | rustpush wire shape | iBlue preflight guarantee | Live status |
| --- | --- | --- | --- |
| Text | IDS command `100`, encrypted `RawIMessage` body | BlueBubbles chat resolves to canonical IDS participants; subject and expressive effect are preserved | Pending |
| Reply | Command `100`; body field `r:<part>:<guid>` | A supplied GUID always has a part; omitted BlueBubbles `partIndex` becomes `0` in TypeScript and native Rust | Pending |
| Attachment/image | Target lookup, MMCS upload, then command `100`; message text uses the attachment replacement character | The exact recipient plus sender-fanout set is resolved before any MMCS bytes are uploaded; file, MIME type, UTI, filename, subject, effect, audio-message flag, and normalized reply metadata are retained | Pending |
| Tapback/emoji reaction | Command `100`; `amk` is `p:<part>/<guid>`; notification `ams` contains the associated text | Part defaults to `0`; text reactions use the stored current text and attachment reactions use `U+FFFC` | Pending |
| Typing start/stop | Command `100`, `eX=0`; one-to-one start can be bodyless, stop/group typing has an encrypted body | Conversation and sender are passed through unchanged | Pending |
| Read receipt | Bodyless command `102`; envelope UUID is the message being acknowledged | The newest incoming message GUID is used when BlueBubbles omits `messageGuid`; no random receipt UUID is generated | Pending |
| Group participant change/leave | Command `190`; binary plist carries complete source/target participant lists and monotonic group version | Ordinary add/remove always retains the sender. Explicit leave alone omits the active sender from the complete target list while the source list still contains it. | Pending |

## Defects closed offline

Twelve issues could have made live testing misleading even after IDS recovered:

1. rustpush formats a reply by unwrapping `reply_part` whenever `reply_guid` is
   present. BlueBubbles normally permits `selectedMessageGuid` without a
   `partIndex`, so iBlue could panic during serialization. All text, multipart,
   and attachment entry points now normalize that pair, and outgoing database
   rows retain the same reply metadata returned to BlueBubbles clients.
2. BlueBubbles socket read events normally identify only the chat. iBlue used
   to let rustpush generate a new random message UUID for command `102`, which
   cannot acknowledge a real message. iBlue now selects the newest incoming
   message in that chat and does not transmit a remote receipt if no incoming
   message exists.
3. BlueBubbles text and attachment routes accepted `subject`, `effectId`, and
   `isAudioMessage`, but the first implementation discarded some of them before
   constructing `NormalMessage`. The JSON-RPC and Rust constructors now retain
   those fields, and the returned local message exposes the same subject,
   expressive effect, and voice-message state.
4. A peer `Read` control was previously confused with the local
   `chat-read-status-changed` operation. Its envelope UUID actually names the
   outgoing message the peer read. iBlue now updates that message's `dateRead`,
   infers delivery if necessary, and emits `updated-message`; a `Delivered`
   control similarly sets `isDelivered` and `dateDelivered` without replacing
   the original message metadata.
5. The native wrapper used `is_typing=false` for both “this is not a typing
   event” and Apple's explicit stop-typing control. It now records event
   presence separately from active state, so BlueBubbles receives both
   `display:true` and `display:false` events.
6. The participant wrapper intentionally forced the local sender into every
   new participant list, which made BlueBubbles' leave route impossible.
   Current OpenBubbles code confirms leave is command `190` with that sender
   removed. iBlue now has a distinct leave constructor; normal add/remove
   retains the safety behavior and cannot accidentally remove the local user.
7. Attachment sends uploaded the complete file to MMCS before `IMClient::send`
   performed its first IDS target lookup. A missing or throttled target therefore
   produced an orphaned Apple upload before returning `NoValidTargets`. iBlue
   now resolves the same recipient-plus-sender fanout set first. The subsequent
   send reuses that lookup through rustpush's cache floor rather than issuing a
   second directory request.
8. The SMS/MMS relay path constructed MMCS attachments even though rustpush's
   MMS serializer accepts only inline attachment data and otherwise panics.
   Relay attachments and relay multipart parts now retain their bytes inline;
   iMessage attachments continue to use MMCS.
9. `ids-canary` previously exited immediately after `message.send` returned and
   described APNs acceptance beside manual delivery instructions. It now starts
   a bounded receipt observer before sending, stores the outgoing GUID in the
   BlueBubbles database, and distinguishes delivery, read, send-error, and
   timeout evidence. A receipt that arrives before the send RPC response is
   buffered and correlated; the wait makes no additional Apple request.
10. Apple's send-error envelope can have its own UUID and names the failed
    outgoing message in `forUuid`. The server previously risked inserting that
    envelope as a separate message. It now updates the original outgoing row
    and emits `message-send-error` with that BlueBubbles message. A
    profile-scoped SQLite process lease also prevents a server and canary from
    concurrently owning the same APNs/IDS state on any supported OS.
11. The normal BlueBubbles send path had the same receipt race as the original
    canary: native stdout can deliver a control before TypeScript receives the
    send response and inserts its GUID. iBlue now buffers unmatched controls by
    GUID, keeps the buffer bounded, and holds controls while attachments or
    group metadata are persisted. Clients always see the outgoing event before
    its delivery/read/error transition. Duplicate controls do not emit repeated
    updates.
12. An APNs reconnect or stored-message replay could emit duplicate Socket.IO
    and webhook events even though the message row used `ON CONFLICT`. Each
    non-receipt envelope now has a durable semantic claim. Completed claims
    suppress replay across restarts; an incomplete claim is owned per process
    and reclaimed after a crash, while clean shutdown drains all inbound tasks
    before SQLite closes.

The reaction path also now fills Apple’s associated-message text instead of
sending an empty `ams`. For image-only messages it uses `U+FFFC`, matching
rustpush's own `MessagePart::Attachment` raw-text representation.

## First-send directory guard

A normal rustpush text send resolves the remote recipient and the sender's own
handle for same-account device fanout. On a completely empty Apple response,
rustpush does not persist a negative cache row. Its inherited
`NoValidTargets` recovery could consequently turn one action into three
directory queries: initial send lookup, forced refresh, and the next send-loop
lookup.

iBlue now disables that immediate native retry and provides `ids-canary`. The
command performs one strict APNs preflight containing exactly the canonical
recipient and registered sender. rustpush's own failed-query retry is disabled,
the general panic guard cannot bisect the two-address batch, and receive remains
passive during the invocation. It calls `message.send` only if both addresses
were returned by that specific response with fresh non-empty identities.
Because the send occurs in the same native process within the one-minute
forced-refresh floor, it resolves both identities from the local cache. An
explicit-empty, omitted, stale, error, timeout, or panic result creates a
72-hour passive policy and never invokes `message.send`.

## Evidence

- The BlueBubbles contract test covers omitted reply parts for text, multipart,
  and direct attachment requests; text/attachment subject and effect fields;
  the audio-message flag; current-text and image tapbacks; implicit outbound
  read-receipt target selection; inbound delivery/read timestamp updates; and
  explicit stop-typing delivery.
- The native macOS framework build compiles the same Rust message constructors.
- Focused Rust unit tests prove native reply normalization, stop-typing
  preservation, leave-group sender removal, exact MMCS preflight target
  planning, and inline MMS attachment selection independently of the TypeScript
  API.
- Canary unit/CLI tests prove one `handle.lookup` call, both required addresses
  in that call, no general `handle.validate`, no direct-HTTPS comparison, and
  zero `message.send` calls on explicit-empty, omitted, or failed responses.
  Success-path tests additionally prove pre-response receipt buffering, durable
  outgoing GUID storage, delivery state, and `Error(forUuid)` correlation.
- Native RPC tests prove that a second process cannot own the same profile and
  that clean child shutdown releases the cross-platform SQLite lease.
- BlueBubbles service tests inject delivery/read controls before the send RPC
  resolves and prove `new-message` precedes both durable status transitions.
  Store tests prove duplicate controls are no-ops and APNs envelope claims are
  completed, released after failure, or reclaimed by a new process owner.
- The native RPC child forces both no-retry flags even if an embedder attempts
  to set them to `0`; the strict Rust method directly invokes `cache_keys` once
  under one timeout/catch boundary and contains no bisection loop.
- None of these checks starts APNs, queries IDS, uploads MMCS data, or contacts
  another Apple endpoint.

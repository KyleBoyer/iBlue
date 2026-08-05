# Official BlueBubbles client bootstrap audit

This audit traces the stock
[`BlueBubblesApp/bluebubbles-app@0a985fc`](https://github.com/BlueBubblesApp/bluebubbles-app/tree/0a985fc032e61fefecff1a995391a9bc01c4a26d)
client (2026-08-03) against iBlue. It complements the server route inventory:
the 91-route inventory says what exists, while this document identifies what a
stock client actually touches during connection, first sync, and startup.

No Apple service is involved in these checks. They exercise only iBlue's local
HTTP and Socket.IO compatibility layer.

The later published client tag
[`v2.0.0+89`](https://github.com/BlueBubblesApp/bluebubbles-app/tree/2d2ed90781885945f84d09812f760062ec7ca07b)
was also compared directly with this pinned commit. There are no changes to the
REST API classes or Socket.IO request/event contract; the only selected-network
diff is internal HTTP-service plumbing. The connection and sync sequence below
therefore remains valid for that 2.0 release tag.

## Connection and setup sequence

The manual connection dialog saves the URL/password and first requires a
successful authenticated Socket.IO connection. It then requests
`GET /api/v1/fcm/client`, but its own source explicitly treats Firebase setup
as a secondary, non-blocking concern. See
[`manual_entry_dialog.dart`](https://github.com/BlueBubblesApp/bluebubbles-app/blob/0a985fc032e61fefecff1a995391a9bc01c4a26d/lib/app/layouts/setup/dialogs/manual_entry_dialog.dart)
and
[`connecting_dialog.dart`](https://github.com/BlueBubblesApp/bluebubbles-app/blob/0a985fc032e61fefecff1a995391a9bc01c4a26d/lib/app/layouts/setup/dialogs/connecting_dialog.dart).

The alternate credentials page performs the following HTTP checks before it
advances:

1. `GET /api/v1/server/info` must return `200`.
2. `GET /api/v1/fcm/client` is attempted.
3. Missing FCM data is tolerated for normal/local URLs; only the client's
   special ngrok and trycloudflare setup paths require Firebase.

That behavior is in
[`server_credentials.dart`](https://github.com/BlueBubblesApp/bluebubbles-app/blob/0a985fc032e61fefecff1a995391a9bc01c4a26d/lib/app/layouts/setup/pages/sync/server_credentials.dart).

iBlue therefore returns the same `404` error detail as an unconfigured
BlueBubbles server for `GET /fcm/client`: `Google Services file not found.` It
does not pretend to provide Firebase credentials. Realtime operation continues
over Socket.IO and webhooks, and `POST /fcm/device` remains an explicit `501`.

## First full sync

[`setup_service.dart`](https://github.com/BlueBubblesApp/bluebubbles-app/blob/0a985fc032e61fefecff1a995391a9bc01c4a26d/lib/services/backend/setup/setup_service.dart)
fetches server details before starting
[`full_sync_manager.dart`](https://github.com/BlueBubblesApp/bluebubbles-app/blob/0a985fc032e61fefecff1a995391a9bc01c4a26d/lib/services/backend/sync/full_sync_manager.dart).
The required network sequence is:

1. `GET /api/v1/server/info`;
2. `GET /api/v1/chat/count`;
3. paged `POST /api/v1/chat/query` with `with: ["lastMessage"]`;
4. for each chat, paged `GET /api/v1/chat/:guid/message` including
   attachments, handle, attributed body, summary information, and payload data;
5. on desktop, `GET /api/v1/contact` for contact-to-handle matching.

All five operations have native or isolated-neutral iBlue handlers. The local
contract test mirrors the request bodies and verifies the fields read directly
by the stock client's `Chat.fromMap` and `Message.fromMap` parsers.

## Post-setup startup

[`startup_tasks.dart`](https://github.com/BlueBubblesApp/bluebubbles-app/blob/0a985fc032e61fefecff1a995391a9bc01c4a26d/lib/helpers/backend/startup_tasks.dart)
then:

- refreshes `/server/info` in the background;
- skips FCM device registration when no Firebase configuration was saved;
- checks `GET /api/v1/server/update/check` after 30 seconds; and
- starts incremental synchronization when the connection is available.

iBlue returns an honest no-update result for the check. Installing an Electron
BlueBubbles update remains unsupported because iBlue has an independent
release lifecycle.

The client also listens for `imessage-aliases-removed`. iBlue compares each
native IDS account-state update with the preceding profile snapshot, strips IDS
transport prefixes, updates the active sending-handle set immediately, and
emits BlueBubbles' `{ aliases: [...] }` payload over Socket.IO and matching
webhooks when Apple removes an address.

`GET /server/info` returns `detected_imessage` in BlueBubbles' bare-address
form. iBlue keeps canonical `mailto:`/`tel:` values internally for IDS but
removes that transport prefix from the public metadata, matching the upstream
server's `chat.account_login.split(':').at(-1)` behavior.

The same response returns `macos_time_sync: null`. Upstream defines this field
as the SNTP clock offset in seconds, not the current epoch time; `null` is its
own failure/unavailable value. iBlue does not run `sntp time.apple.com`, and it
must not substitute `Date.now()` because clients could interpret that as a
multi-decade clock skew.

For a reported server version of `1.9.9`, the client selects the row-ID path in
[`incremental_sync_manager.dart`](https://github.com/BlueBubblesApp/bluebubbles-app/blob/0a985fc032e61fefecff1a995391a9bc01c4a26d/lib/services/backend/sync/incremental_sync_manager.dart):
`POST /api/v1/message/query` with bounded `message.ROWID` predicates and a
`metadata.total` count. iBlue parses those predicates into parameterized local
SQLite bounds, and that response is covered by the contract suite.

## Result

A stock client has no known mandatory pairing or initial-sync dependency among
the remaining structured-`501` routes. Those routes correspond to optional
features or server administration. The current compatibility boundary is
therefore feature-level—such as FaceTime sessions, Find My, or
Electron server control—not a blocker to connection, history sync, realtime
events, or the implemented messaging calls.

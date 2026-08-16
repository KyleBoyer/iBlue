# iBlue

iBlue is a TypeScript BlueBubbles-compatible API backed by a small Rust
`rustpush` engine. It connects directly to Apple IDS/APNs, keeps each Apple
account in its own profile, and does not use Messages.app, `chat.db`, a VM, or a
SIP bypass.

Any BlueBubbles client can point at it: iBlue serves the BlueBubbles v1 REST
API, Socket.IO events, and outbound webhooks, tracking upstream release
`1.9.9`.

The implementation is currently a tested macOS prototype. The Linux native
bridge and production container compile and pass runtime/API smoke tests, and
an experimental source-integrated Unicorn NAC backend is available when the
operator supplies both an extracted Mac hardware key and the exact supported
Apple binary as read-only external files. Live Linux registration has not yet
been verified; Windows is unbuilt and experimental.

## Requirements

- Node.js 22+
- A Rust toolchain with `cargo` (the container image pins Rust 1.92)
- `git`
- macOS: Xcode Command Line Tools, which build the Objective-C hardware-info
  and NAC shims
- Docker, optional and only for the container workflow

Go and the `Makefile` are not part of this flow. They belong to the inherited
Matrix bridge described under [Provenance](#provenance).

## Build

From the repo root:

```bash
npm install
npm run prepare:native   # clones/pins Rust + applies iBlue patches
npm run build:native     # builds the Rust engine
```

`build:native` produces `pkg/rustpushgo/target/release/iblue-native`, which the
CLI resolves automatically. Override it with `--native <path>` or
`IBLUE_NATIVE_PATH`.

## First run

Run once per profile as a baseline check:

```bash
npm run dev -- login --profile secondary --apple-id name@example.com
npm run dev -- ids-canary --profile secondary --message 'Hello from iBlue'
npm run dev -- ids-cooldown status --profile secondary
```

The login prompt accepts `sms` when no trusted device is available.

## Run the service

```bash
IBLUE_SERVER_PASSWORD='replace-me' npm run dev -- serve --profile secondary
```

This starts the BlueBubbles-compatible REST, Socket.IO, and webhook service on
`127.0.0.1:1234`; change it with `--host` and `--port`. The server password is
what BlueBubbles clients authenticate with, and it can come from
`IBLUE_SERVER_PASSWORD`, `IBLUE_SERVER_PASSWORD_FILE`, `--server-password`, or
`--server-password-file`. Startup prints the listening address, the account's
handles, and the current IDS mode.

Open `http://127.0.0.1:1234/docs/` for the interactive Swagger UI. Use its
**Authorize** button to enter the server password once; requests made with
**Try it out** add it as the `password` query parameter. The same OpenAPI 3.1
document is available as JSON at `/openapi.json` or `/docs/json`, and as YAML
at `/docs/yaml`. Documentation routes describe the API but do not expose
profile data and therefore do not require the server password themselves.

The current macOS FaceTime installation, persistent automatic video responder,
launchd controls, staging workflow, logs, and troubleshooting steps are recorded
in [the FaceTime autoplay handoff](docs/facetime-autoplay-handoff.md).

## Connect a BlueBubbles client

Point the client at the address above and give it the same server password.
Clients pass it as a `password`, `guid`, or `token` query parameter, which is
what iBlue's auth hook accepts.

For realtime events, clients either connect over Socket.IO or receive webhooks.
Stock BlueBubbles registers webhooks from its desktop UI; iBlue has no UI, so
register the receiver over the API:

```bash
curl -X POST "http://127.0.0.1:1234/api/v1/webhook?password=$IBLUE_SERVER_PASSWORD" \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:8742/webhook","events":["*"]}'

curl -s "http://127.0.0.1:1234/api/v1/webhook?password=$IBLUE_SERVER_PASSWORD"
```

Subscriptions are profile-local and durable, so they survive restarts. `"*"`
receives everything; named events include `new-message`, `updated-message`,
`message-send-error`, `typing-indicator`, `chat-read-status-changed`, the group
name/icon/participant events, and the scheduled-message events. Payloads keep
BlueBubbles' `{type,data}` body. Receivers that need a secret should carry it in
the registered URL's query string, since iBlue sends only its own
`X-iBlue-Webhook-Delivery-Id` and `X-iBlue-Webhook-Event` headers. Delivery is
at-least-once through a durable retrying outbox; deduplicate on the delivery-id
header.

## Additive message components

iBlue exposes Apple components that are not part of BlueBubbles' upstream
schema under `/api/v1/iblue`. Received iCloud Photos links include a normalized
`message.iBlue.icloudShare` summary. Resolve item-level photo/video metadata and
authenticated media proxy paths with:

```bash
curl -s "http://127.0.0.1:1234/api/v1/iblue/icloud-share/<message-guid>?password=$IBLUE_SERVER_PASSWORD"
curl -L "http://127.0.0.1:1234/api/v1/iblue/icloud-share/<message-guid>/item/<item-guid>/original?password=$IBLUE_SERVER_PASSWORD"
```

Send the native Photos Messages app balloon, rather than a plain URL preview,
with `POST /api/v1/iblue/icloud-share` and JSON
`{"chatGuid":"...","url":"https://share.icloud.com/photos/..."}`. iCloud
links are bearer URLs and expire on Apple's schedule; iBlue never returns the
short-lived CloudKit access token or Apple CDN URL to API consumers.

Fresh links use iCloud.com's Photos API and are deliberately opt-in because
Apple treats that as a separate web sign-in. Enable it once with
`iblue icloud-web-setup --profile secondary`; iBlue reuses the encrypted
password hash already saved by the normal account login, asks only for Apple's
separate web MFA confirmation, and stores the resulting web session inside the
profile's encrypted credential record. Then send JPEG, PNG, HEIC/HEIF,
QuickTime MOV, or MP4 media as a newly created Photos share with multipart
`POST /api/v1/iblue/icloud-share/create`, using the fields `media`, `chatGuid`,
and optional `title`, `caption`, `subcaption`, and `ldText`. iBlue verifies
Apple's public share before it sends the native Photos Messages app balloon.
Apple's web importer rejects GIF; animated GIF remains supported through the
ordinary iMessage attachment API.

## Outbound testing

Outbound sends are gated behind a deliberate IDS flow. For the first test
against a known number:

```bash
npm run dev -- ids-cooldown enable --profile secondary --hours 24
npm run dev -- ids-canary --profile secondary --message 'Hello from iBlue' tel:+16515550100
npm run dev -- ids-canary-status --profile secondary
npm run dev -- ids-cooldown disable --profile secondary
npm run dev -- outbound-verify --profile secondary --confirm-live tel:+16515550100
```

> `ids-canary` is an Apple-approved sanity check before enabling full outbound
> verification. It should be used with a known contact and no ambiguous contact
> handles.

While a cooldown is configured, `serve` runs in passive receive mode: inbound
messages and every read route keep working, and every outbound operation —
send, reaction, edit, unsend, typing, read receipt, group control — is refused
with an explicit error. The policy is read at startup, so restart the server
after enabling or disabling it.

## Commands

```bash
# Creates/reuses an isolated APNs device profile and signs in directly to IDS.
npm run dev -- login --profile secondary --apple-id name@example.com

# Starts the BlueBubbles-compatible REST, Socket.IO, and webhook service.
IBLUE_SERVER_PASSWORD='replace-me' npm run dev -- serve --profile secondary

# Keep receiving during an Apple IDS lookup cooldown without querying peer keys.
IBLUE_SERVER_PASSWORD='replace-me' npm run dev -- serve --profile secondary --ids-passive

# Reports profile, credential, and native-engine health.
npm run dev -- doctor --profile secondary

# Persist a 24-hour passive cooldown across server restarts and guard live IDS diagnostics.
npm run dev -- ids-cooldown enable --profile secondary --hours 24

# Inspect saved IDS services, renewal timing, and local keys without contacting Apple.
npm run dev -- registration-inspect --profile secondary

# After the timer expires, make one target lookup over one IDS path.
# An empty result automatically extends passive mode for 72 hours.
npm run dev -- ids-probe --profile secondary --transport apns mailto:known-good@example.com

# For the first outbound test, preflight the recipient plus our sender in one
# strict APNs request (no internal retry or panic bisection) and send only if
# this response returns both identities. Any incomplete/failed result sends
# nothing and automatically extends passive mode for 72 hours.
# Stop any server using this profile first. The command records the outgoing
# GUID and waits up to 30 seconds for a matching delivery/read/error receipt.
npm run dev -- ids-canary --profile secondary --message 'Hello from iBlue' tel:+16515550100

# Inspect that one canary and any late persisted receipt entirely offline.
# Before the canary it still reports the active cooldown. This never starts the
# native process, APNs, or an Apple request.
npm run dev -- ids-canary-status --profile secondary

# Only after that canary is confirmed delivered: remove passive mode, then run
# the guarded BlueBubbles REST verification suite. It exercises typing start/
# stop, read, text, reply, haha tapback, and PNG-image endpoints once.
npm run dev -- ids-cooldown disable --profile secondary
npm run dev -- outbound-verify --profile secondary --confirm-live tel:+16515550100

# Recovery only if that canary is empty—or an interrupted journal has an unknown
# outcome and the recipient received nothing—and its cooldown has fully elapsed:
# refresh the saved registration once, without a password/2FA/new device, then
# enforce another 72-hour quiet period before the next canonical canary.
npm run dev -- registration-refresh --profile secondary --confirm

# Development convenience: one final Keychain approval, then no prompt after rebuilds.
npm run dev -- migrate-credentials --profile secondary

# Deregisters this profile from Apple IDS, then removes its local credential.
npm run dev -- logout --profile secondary
```

`npm run dev -- help` prints every flag, including the cross-platform
`--hardware-key-file` / `--nac-binary-file` and the container-oriented
`--credential-key-file` / `--data-root`.

## Profile state

Profile state lives under `~/Library/Application Support/iBlue/profiles/<name>`
on macOS. Apple credentials use the OS credential store; only APNs/IDS transport
state and the account identifier are written to `session.json`. Messages,
chats, attachments, webhook subscriptions, and the delivery outbox live in that
profile's SQLite database. See the
[platform and credential guide](docs/platform-support.md) for headless secrets,
moving a stopped encrypted profile to Windows/Linux/containers, IDS passive
mode, and the explicit `logout --local-only` fallback.

## Docker

`Dockerfile` builds the TypeScript service and the Rust engine into a
non-root runtime image that exposes port 1234 and stores profiles in the `/data`
volume. `docker-compose.example.yml` is a working starting point: it passes the
hardware key, NAC binary, credential key, and server password as file-based
secrets, none of which are copied into the image.

## Documentation

- [Platform support and credentials](docs/platform-support.md)
- [BlueBubbles compatibility contract](docs/bluebubbles-compatibility.md)
- [Exact API surface audit](docs/bluebubbles-api-surface.md) — native routes and
  events versus explicit capability errors
- [Official client bootstrap audit](docs/bluebubbles-client-bootstrap.md) — the
  stock app's connection, first-sync, and startup calls
- [Outbound wire audit](docs/outbound-wire-audit.md) — offline protocol evidence
  versus operations that still need live delivery verification
- [Same-user account isolation audit](docs/profile-isolation.md) — why an iBlue
  profile does not sign in to, read from, or modify Messages.app
- [IDS directory audit](docs/ids-directory-audit.md)

## Troubleshooting

- **Contact Key Verification must be off.** iBlue registers as a new iMessage
  device on the Apple ID, and that registration does not work while CKV is
  enabled. Turn it off first: on iPhone, **Settings → [your name] → Contact Key
  Verification**; on a Mac, **System Settings → [your name] → Contact Key
  Verification**.
- **Reads work but every send fails.** Check for a configured IDS cooldown with
  `ids-cooldown status`; passive mode refuses outbound operations by design.
  `server/info` reports the live value as `data.iBlue.idsMode`.
- **A client connects but sees no realtime events.** Confirm it is using
  Socket.IO, or that its webhook receiver is registered — see
  [Connect a BlueBubbles client](#connect-a-bluebubbles-client).
- **Native engine logs.** Set `IBLUE_NATIVE_LOGS=1` to forward the Rust engine's
  log lines to stderr.

## Provenance

iBlue is built on [rustpush](https://github.com/OpenBubbles/rustpush) and
targets the API of the
[BlueBubbles server](https://github.com/BlueBubblesApp/bluebubbles-server). The
repository is a fork of
[Corten-Matrix](https://github.com/lrhodin/corten-matrix), a Matrix–iMessage
puppeting bridge on the same engine, and it still carries that bridge's Go
source under `cmd/corten-matrix/`, `pkg/connector/`, `pkg/bbctl/`, `imessage/`,
and `ipc/`, plus its `Makefile` build. None of it is used by iBlue; for its
setup and usage, follow the
[upstream README](https://github.com/lrhodin/corten-matrix#readme).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), and [AGENTS.md](AGENTS.md) for the FFI
boundary and build-regeneration rules.

## License

MPL 2.0 — see [LICENSE](LICENSE).

# Platform and credential support

iBlue has a portable TypeScript API process and a platform-sensitive Rust
transport process. A platform is supported only when both layers work there.

| Runtime | Status | iMessage validation | Credential backend |
| --- | --- | --- | --- |
| macOS 13+ | Build/native initialization, isolated Apple password + SMS 2FA, IDS registration, APNs text/image/tapback receive, attachment download, and webhook delivery verified; outbound target lookup currently throttled for the new test account | Native Apple framework; no extracted key | macOS Keychain |
| Linux | TypeScript tests plus native compile, link, and RPC startup verified; live registration unverified | Experimental Unicorn backend with external hardware key and allowlisted Apple binary | Secret Service, or encrypted file |
| Linux container | Production image build and non-root runtime verified on arm64; live registration unverified | Same experimental portable backend; both inputs are read-only secrets | Encrypted file with mounted key |
| Windows | Experimental; native MSVC workflow and JSON-RPC smoke test are checked in but have not yet run on a Windows host | Portable Unicorn backend; live registration remains unverified | Windows Credential Manager, or encrypted file |

The portable TypeScript API is not the limiting layer. iBlue's
`open-absinthe` overlay now has two source-built NAC paths: Apple's
`AAAbsintheContext` framework on macOS, and an experimental x86_64 routine
emulator backed by Unicorn on portable hosts. `system.version` reports the
selected backend and fails closed: the portable backend is unavailable until
the external Apple binary exists and matches the one supported digest.

The BlueBubbles-compatible server metadata uses a stable, profile-scoped opaque
`computer_id`. It never publishes the physical Mac hardware UUID that the native
Apple registration protocol retains internally.

On Unix hosts, profile and native-state directories are mode `0700`. Session
state, the IDS key cache, the local message SQLite database and its WAL/SHM
sidecars, encrypted credential material, and downloaded attachments are mode
`0600`. Startup repairs more-permissive modes left by older builds.

Corten's current release publishes macOS and Linux binaries, but its source
documentation says the source-build path is macOS-only. The portable emulator
integrated here instead comes from the SSPL-licensed rustpush overlay in
`mackid1993/imessage-cleanup` at commit
`4f9cdfdf83080439fe2021f54bce305165483329`, which traces its approach to
pypush. iBlue removed that fork's automatic proprietary-binary download,
unique-device logging, and extracted XNU routine. Upstream rustpush's public CI
covers Ubuntu and macOS, not Windows. Unicorn itself runs its Rust crate and
bundled C engine on Windows/MSVC with the Visual Studio developer environment
and Ninja.

A 2026-08-03 `x86_64-pc-windows-gnu` cross-check compiled the complete native
dependency graph and iBlue binary source after supplying MinGW's sysroot to
bindgen. That includes the Windows crypto, socket, native-keyring, portable NAC,
x86-only Unicorn paths, and the strict single-attempt IDS lookup RPC used by the
outbound canary. A full GNU link then reached an upstream
`unicorn-engine-sys` 2.1.5 packaging conflict: it requests dynamic
`winpthread` while Rust's GNU runtime also selects the static archive, producing
duplicate `pthread_mutex_lock` and `pthread_mutex_unlock` symbols. The crate
deliberately skips that pthread link on
MSVC, so this does not predict the result of the intended Windows build, but it
does mean the GNU target is not currently distributable. An actual Windows
MSVC build with Visual Studio Build Tools, CMake/Ninja, and libclang remains the
preferred next test; iBlue should not yet be advertised as working on Windows.
The checked-in `iBlue Windows native build` workflow performs that exact MSVC
build, runs the platform-neutral TypeScript suite, exercises both the native
encrypted-file backend and a UUID-isolated synthetic Windows Credential Manager
item, calls `system.version` and `system.shutdown` on the resulting `.exe` in
offline-only mode, and publishes the executable as a short-lived artifact. A
green run is required before changing the Windows status; live login and
messaging remain a separate gate.

A local `cargo-xwin` MSVC cross-build also reached the vendored OpenSSL build
after compiling the Windows Rust dependency graph. It cannot finish that step
on macOS because OpenSSL's `VC-WIN64A` configuration deliberately requires a
Windows-style Perl implementation. This is a limitation of the cross-host test,
not evidence that OpenSSL fails on Windows. The Windows workflow therefore
installs Strawberry Perl explicitly and passes its absolute executable path to
`openssl-src`, in addition to checking the Visual Studio `nmake` environment.

The rustpush overlay also hardens cached IDS keys against backward wall-clock
adjustments reported in
[rustpush issue #29](https://github.com/OpenBubbles/rustpush/issues/29).
Windows sleep/wake and NTP correction can make a saved cache timestamp appear
to be in the future; upstream called `expect` on that duration and could panic
the IDS task. iBlue now saturates the apparent age at zero. This preserves the
entry that was valid immediately before the clock correction and avoids both
the panic and an unnecessary forced directory refresh. A focused regression
assertion covers future and normally elapsed timestamps, and the portable
Windows-target compile covers the production branch.

The APNs connection path is also bounded during initial startup and reconnect.
An upstream fork identified that the first socket generation could wait on bag
fetch, DNS, TCP, or TLS before the resource manager—and therefore its normal
regeneration timeout—existed. iBlue adapted that finding from
[`Offline-DC/rustpush@053dfc9`](https://github.com/Offline-DC/rustpush/commit/053dfc943360d47cf38091c7814a2764cf651c32),
but replaces the fork's blocking `ToSocketAddrs` call with Tokio's asynchronous
resolver and tries every returned address. It prefers TCP 5223 and falls back to
TCP 443, matching [Apple's documented device APNs behavior](https://developer.apple.com/documentation/usernotifications/troubleshooting-push-notifications).
Each port attempt is bounded at 20 seconds inside a 60-second limit for the
complete socket-open operation, so a firewall that silently drops 5223 cannot
prevent the 443 fallback. A complete timeout enters the existing exponential
reconnect path. Direct outbound access to `*.push.apple.com` on 5223 or 443 is
therefore required; TLS interception is unsupported by Apple. This changes
neither IDS directory lookup policy nor the one-shot canary budget; it prevents
a broken network path from indefinitely stalling the APNs receiver that feeds
local history, Socket.IO, and webhooks.

## Credential selection

By default the native process uses the operating-system credential service:

- macOS Keychain
- Windows Credential Manager
- freedesktop Secret Service on Linux

Set `--credential-key-file <path>` or `IBLUE_CREDENTIAL_KEY_FILE` to use the
headless backend instead. That file must contain exactly 32 raw random bytes,
64 hexadecimal characters, or base64 encoding of 32 bytes. The backend stores
the Apple IDS credential record as AES-256-GCM ciphertext in
`<profile>/native/credentials.enc`; the encryption key is never written into
the profile when an explicit external key path is used.

The portable backend has offline regression coverage for all three key
encodings, authenticated profile/service binding, wrong-key and ciphertext
tamper rejection, fresh nonces and atomic cross-platform replacement,
idempotent deletion, and Unix mode `0600`. A failed Windows replacement keeps
the previous credential instead of deleting it first. Those checks use only
synthetic temporary credentials and do not contact Apple or invoke an
operating-system credential service.

Use a read-only secret mount for the credential key. Do not bake it into a
container image, put it on the command line, or commit it. The profile root
must be a persistent volume because it also contains APNs/IDS registration
state, local message history, and attachments.

### Moving a profile between operating systems

The encrypted credential is portable only as a set. Before moving a macOS
profile to Linux, Windows, or a container, stop every process using it and run
`migrate-credentials` once on the source Mac. The upgraded native engine writes
an owner-only `native/credential-service` identity that preserves the existing
Keychain/AES-GCM namespace. Move—not independently run duplicate copies of—the
complete profile directory, including `session.json`, `native/keystore.plist`,
`native/credentials.enc`, `native/credential-service`, the local database, and
attachments. Supply `credential.key` as a separate read-only secret on the
destination, along with the required hardware-key and NAC-binary inputs.

Earlier builds derived the AES-GCM associated-data service exclusively from the
canonical absolute native path. That isolated profiles on one host but made a
valid ciphertext fail authentication after, for example, moving from macOS's
Application Support directory to container `/data`. The persisted service file
is seeded with exactly that legacy value on first upgraded startup, so existing
Keychain and encrypted-file records continue working without re-login, while a
subsequent path/OS move retains the same opaque identity. Invalid or modified
service files fail closed before credential access. Do not start a copied
profile simultaneously on two hosts: both copies contain the same APNs device
and IDS identity, while the process lease only coordinates a single filesystem.

During local development, rebuilding an ad-hoc-signed macOS native binary
changes its code hash, so Keychain can ask for authorization again even after
the previous build was allowed. Run the following once to copy an existing
profile credential into the encrypted-file backend:

```bash
npm run dev -- migrate-credentials --profile secondary
```

macOS asks for Keychain approval once during migration. iBlue then creates
owner-only `credential.key` and `native/credentials.enc` files and selects them
automatically for that profile. The original Keychain item is retained as a
rollback path. This convenience mode trades Keychain's process ACL for regular
filesystem permissions: anyone who can read both files can recover the Apple
credential, so do not sync, share, or commit the profile directory. Production
and container deployments should continue to mount the key from an external
secret path instead.

## Portable validation inputs

Linux, containers, and the proposed Windows build require
`--hardware-key-file <path>` or `IBLUE_HARDWARE_KEY_FILE`. The file contains a
hardware key extracted once from a real Mac. The Mac is not required while
iBlue runs, but the extracted key should be handled as a device credential and
mounted read-only.

The hardware key is read by TypeScript and sent to the per-profile native
engine over its private stdin JSON-RPC channel. It is not placed in process
arguments or persisted in `session.json`.

Portable registration also requires `--nac-binary-file <path>` or
`IBLUE_NAC_BINARY_FILE`. iBlue does not bundle or download this proprietary
component; the operator must obtain `IMDAppleServices` from Apple software and
mount it read-only. Fixed routine offsets make the allowlist deliberately
exact. The supported file has SHA-256:

```text
74c2a8fe826a478f14f6e17b3709a8b315e8c0e0e34e3fba6b9c4eee2f4516e9
```

Do not commit either validation input or copy it into a container image. A
missing, unreadable, or mismatched binary leaves `registrationAvailable` false
before Apple credentials are requested. This verifies provenance and layout;
it does not by itself prove that a live Apple registration will succeed.

## Profile lifecycle and logout

`login` persists the synthetic device ID and APNs certificate/token immediately
after native initialization, before asking for the Apple Account password. A
cancelled login or a retryable IDS registration failure therefore reuses the
same Apple push device on the next run. Passwords, PETs, and password hashes are
never written to `session.json`.

Normal logout is remote-first:

```bash
npm run dev -- logout --profile secondary
```

iBlue sends Apple's signed IDS self-deregistration request using that profile's
APNs token and IDS authentication certificate. It removes the OS/key-file
credential and `session.json` only after Apple accepts deregistration. If the
network or Apple rejects the request, credentials and session state are retained
so logout can be retried. Local message history and downloaded attachments are
not erased.

`--local-only` skips Apple deregistration. It is intended only for an
unrecoverable or already-removed registration and warns that a ghost device may
remain on the Apple Account. The user should remove that device through
`account.apple.com` if normal logout cannot be completed. Local-only cleanup
does not initialize APNs and therefore does not require the external NAC binary,
a hardware key, or network access. Normal remote deregistration needs the saved
hardware identity on a portable host, but it does not need fresh NAC validation;
a temporarily unavailable NAC binary does not trap an existing registration.

## Container image

The checked-in `Dockerfile` builds a multi-stage Linux image containing the
TypeScript service and native Rust bridge. The runtime image:

- runs as the unprivileged `iblue` user (UID/GID 10001);
- stores profiles under a persistent `/data` volume;
- accepts hardware-key, NAC-binary, credential-key, and server-password files
  through read-only Docker secrets;
- needs outbound HTTPS/DNS and Apple push connectivity (normally TCP 5223).

Build and inspect the non-Apple runtime with:

```bash
docker build -t iblue:dev .
docker run --rm iblue:dev help
```

`docker-compose.example.yml` shows the intended secret and volume wiring. The
image contains the portable emulator but never the Apple binary or hardware
identity. Building and starting it proves packaging portability, not live
iMessage support; Linux login/registration remains explicitly unverified.

The checked-in `iBlue Linux and container build` workflow repeats the native
build and encrypted-credential tests on x86_64 Linux. Its independent container
job builds the production image, verifies the default UID/GID is 10001 and the
fresh named profile volume is writable by that non-root user, then exercises
both the TypeScript CLI and native
JSON-RPC with container networking disabled. These gates prove packaging and
secret-backend behavior without possessing Apple inputs or contacting Apple.

A supported container deployment will need:

- a persistent profile volume;
- read-only hardware-key, NAC-binary, and credential-key secret mounts;
- outbound HTTPS/DNS and Apple push connectivity (normally TCP 5223);
- one iBlue process per independently managed profile, or multiple isolated
  per-profile native subprocesses under the TypeScript service.

There is no useful macOS-container target: macOS containers are not a supported
deployment model, and the native validation path needs Apple frameworks.

## Verification performed

On 2026-08-03 the arm64 Linux build was compiled and linked from a clean Docker
context, the native process completed `system.version` and clean shutdown over
NDJSON, and the TypeScript REST/Socket.IO/webhook test suite passed under Linux
Node 22. The production image also ran as UID 10001. The portable Unicorn build
also compiled on arm64 macOS and its capability gate was exercised entirely
offline: a missing or mismatched external binary reported unavailable, while
the exact allowlisted file reported available. No Linux Apple login,
registration refresh, message send, or APNs receive claim is made. On macOS,
the isolated secondary Apple Account password flow, SMS two-factor fallback, six-digit
code verification, and IDS registration completed successfully without signing
Messages.app into that account. The resulting profile uses a distinct APNs
device, stores its Apple credential in a profile-derived macOS Keychain entry,
and keeps both `session.json` and the native keystore owner-readable only. A
server smoke test opened no files under `~/Library/Messages`; the inode, size,
and timestamps of `chat.db` and `com.apple.iChat.plist` were unchanged before
and after the isolated server run. A live iMessage sent from another Apple
account then arrived directly over APNs and was delivered to a wildcard webhook
as a BlueBubbles-compatible `new-message` payload. The main Messages app remained
functional and the iBlue native process held no open file under
`~/Library/Messages`.

The same live conversation delivered a typing notification and a 235,893-byte
JPEG attachment. iBlue downloaded the MMCS object, persisted it under the
secondary profile, exposed its BlueBubbles attachment metadata, and returned
the complete JPEG with the correct MIME type through the download endpoint. The
live payload also exposed that rustpush assigns a conversation UUID to some
one-to-one messages; iBlue now classifies the chat from its non-self participant
count, excludes its own handle, and produced the correct direct-chat style and
GUID for the attachment event.

An inbound `laugh` tapback was subsequently received over APNs, correlated to
the image message GUID, persisted in the profile database, and emitted as a
BlueBubbles `new-message` webhook. A later sticker reaction was received as a
49,495-byte HEIC, persisted with `isSticker: true`, correlated to the image, and
delivered immediately to the same webhook. Outbound tapbacks and explicit
handle-availability lookup returned Apple's no-valid-target condition for both
tested recipient emails (`kyleboyer96@icloud.com` and `xtremeness@live.com`) and
for the sender's phone number. Bare and explicit `mailto:` email forms, plus
bare, `tel:`, E.164 `+1`, country-code-without-plus, and ten-digit phone forms,
all produced the same empty result. The received events identify the sender as
the canonical `tel:+16513196252`, independently confirming that the outbound
failure is not caused by the address prefix or phone formatting. The recipient confirmed
that none of the earlier text or reaction attempts arrived. Those text attempts
had been incorrectly reported as sent because inherited rustpush code silently
fell back from an `iMessage` conversation to an apparent SMS relay. iBlue now
keeps the service encoded in the BlueBubbles chat GUID strict: `iMessage` chats
do not fall back to SMS, and explicit `SMS` chats require a positively verified
relay. A repeated live request returned HTTP 500, created no database row, and
emitted no message webhook.

rustpush also caches empty IDS lookups for an hour. Its shared bridge wrapper
historically followed `NoValidTargets` with a forced refresh and another send
attempt. Because Apple does not insert a cache row for a completely empty
response, one user action could therefore produce an initial lookup, a forced
refresh, and a third lookup when the send loop ran again. The iBlue native child
now disables that immediate send retry and rustpush's lower-level failed-query
retry; TypeScript owns the durable cooldown policy.
A prior live message-required refresh reached Apple with the correct lookup
headers but again returned zero identities. Live outbound
text/attachment/reaction/typing/read delivery and inbound delivery/read receipts
remain to be verified.

The inbound APNs envelope exposes the sender handle and push token, but not the
peer IDS session token or public encryption/prekey bundle needed for an
authenticated encrypted reply. iBlue therefore does not synthesize an unsafe
raw push when IDS returns no delivery identity.

### Passive IDS cooldown mode

A query-limited account can still receive and decrypt APNs messages while
Apple returns empty peer identity lists. Normal rustpush receive processing
tries to resolve the sender key for every encrypted message so it can verify
the signature; its forced retry can therefore create a new IDS directory query
for each message after the one-minute refresh floor. During an account cooldown,
either run the server explicitly in passive mode or persist a timed policy:

```bash
IBLUE_SERVER_PASSWORD='replace-me' npm run dev -- serve --profile secondary --ids-passive
npm run dev -- ids-cooldown enable --profile secondary --hours 24
```

This is profile/process scoped. It preserves APNs receive, message decryption,
MMCS attachment download, the local history database, Socket.IO, and webhooks,
but deliberately skips the inbound sender-key directory lookup. Incoming
messages remain annotated with `iBlue.senderVerificationFailed: true`; passive
mode does not claim cryptographic sender authentication. Server metadata exposes
the current mode at `data.iBlue.idsMode`.

An active policy automatically selects passive mode after a server restart and
causes `ids-probe` and `ids-canary` to fail locally before contacting Apple. A probe requires
exactly one target and issues exactly one lookup over the selected transport;
it never adds the profile's own handles or silently compares both directory
paths. APNs tunnel lookup is the production-path default, while direct signed
HTTPS must be selected explicitly:

```bash
npm run dev -- ids-probe --profile secondary --transport apns mailto:known-good@example.com
```

`ids-probe --force` can bypass an active timer, but should be reserved for a
deliberately scheduled single probe. Inspect or remove the policy with
`ids-cooldown status` and `ids-cooldown disable`; an expired policy no longer
blocks a sparse probe, but it keeps server receive handling passive until it is
explicitly disabled. If the result is `empty`, do not try the HTTPS path
immediately. iBlue automatically writes a fresh 72-hour passive policy after an
explicit empty result; override the duration only when deliberately extending
it with `--empty-cooldown-hours`. Restart a running server after an empty result
to ensure it sees the new passive policy. Restart after disabling the policy
following an `available` result to return to normal verified receive handling.

For the first outbound test, prefer `ids-canary` over a probe followed by a
separate API send:

```bash
npm run dev -- ids-canary --profile secondary \
  --message 'Hello from iBlue' tel:+16515550100
```

Stop `serve` for that profile before running the command. iBlue also enforces
this locally: every native process holds a profile-scoped SQLite lease, and a
second server, login, probe, or canary fails before it can start APNs. The lease
uses the operating system's SQLite file lock, so it is released after either a
clean shutdown or a process crash on macOS, Windows, and Linux; there is no
stale PID file to delete. Canary evidence and its new passive hold are written
only after that lease is acquired and the saved client starts, so forgetting to
stop `serve` fails locally without consuming the one-canary journal.

A normal text message targets both the remote recipient and the sending
account's own devices. `ids-canary` therefore asks for those two identities in
one APNs directory request. The strict native path disables the library's
internal error retry, bypasses the general panic-bisection guard, limits the
batch to 18 addresses, and leaves receive handling passive so an incoming push
cannot trigger a second sender-key lookup. It invokes `message.send` only if
both addresses have fresh, non-empty cache entries created or replaced by that
specific response. The send's cache lookup is then local.

The command labels each address `available`, `explicit-empty`, `omitted`,
`stale`, `error`, `timeout`, or `panic`. Only `available` authorizes the send;
every other result writes a new 72-hour passive policy without invoking
`message.send`. Unlike `ids-probe`, the canary has no `--force` bypass for an
active timer. Immediately before its one lookup, the command atomically writes
an owner-only passive hold and `<profile>/ids-canary.json`. The journal contains
a SHA-256 digest rather than the canary plaintext. It changes from
`in-progress` to either `lookup-no-send` or `transport-accepted`, so a crash,
timeout, or local persistence error cannot make the live attempt look safe to
repeat. Any existing journal blocks a second canary before native startup.

When APNs accepts a send, the canary saves its GUID as an outgoing
message in the profile's BlueBubbles database and observes the already-open
push connection for up to 30 seconds. A matching `Delivered`, `Read`, or
`Error(forUuid)` control is reported and persisted; the observer is attached
before the send so a receipt that races the RPC response is not lost. Change
the bounded local wait with `--receipt-wait-seconds 0..300`. This wait performs
no additional directory request.

APNs acceptance by itself is not delivery proof. A timeout therefore says to
keep passive mode and confirm on the recipient, not to repeat the canary. A
delivery/read receipt is machine-verifiable confirmation, but the command still
does not automatically change policy; run `ids-cooldown disable` and restart
the server deliberately. The one attempt and any receipt persisted later by the
passive server can be inspected without credentials, native startup, APNs, or
Apple network access:

```bash
npm run dev -- ids-canary-status --profile secondary
npm run dev -- ids-canary-status --profile secondary --json
```

Human and JSON output both report the active/expired cooldown even when no
canary journal exists yet, as during the pre-canary quiet period. The JSON
policy includes an explicit `active` boolean for automation.

Database delivery/read/error evidence supersedes the bounded observation saved
in the journal. A `lookup-no-send` journal remains as the recovery interlock;
after the following cooldown expires, a successful `registration-refresh`
archives it before starting the next quiet period. An `in-progress` journal
means the process exited before it could durably record whether the request or
send completed, so its outcome is deliberately treated as unknown and the
canary cannot be repeated. If the recipient did not receive it, the same
confirmed refresh recovery becomes available only after the cooldown expires;
the refresh starts another quiet period before a new canary. A failed refresh
keeps the ambiguous journal in place and still starts that quiet period.

After that single canary is confirmed delivered, keep the server stopped,
disable the profile's cooldown, and run the guarded feature suite once:

```bash
npm run dev -- ids-cooldown disable --profile secondary
npm run dev -- outbound-verify --profile secondary \
  --confirm-live --receipt-wait-seconds 30 tel:+16515550100
```

`outbound-verify` starts an ephemeral localhost BlueBubbles server and drives
the real REST routes for typing start/stop, a read receipt, plain text, a reply,
a `haha` tapback, and a PNG attachment. It refuses to start without
`--confirm-live`, while any IDS cooldown record remains configured, when no
incoming target message exists for reply/reaction/read, or when another process
owns the profile. The four durable outgoing operations are polled through the
BlueBubbles message endpoint for delivery/read/error receipts without another
IDS probe.

Progress is journaled after every accepted operation to
`<profile>/verification/outbound-active.json`. A partial failure leaves that
owner-only file in place and a later invocation refuses to repeat the suite;
inspect the recorded GUIDs and recipient state first. A completed run atomically
renames it to `outbound-<run-id>.json`; that completed evidence also interlocks
against an accidental second full run until it is deliberately archived. The report deliberately separates API
acceptance and IDS receipts from recipient-side UI confirmation: typing,
threaded-reply placement, tapback placement, and image rendering still require
inspection on the receiving device.

Passive mode does not bypass outbound IDS routing and does not fabricate
delivery records. Outbound text, reaction, attachment, typing, and read requests
will still fail safely when Apple supplies no recipient identities. Remove
`--ids-passive` only after a sparse probe confirms normal target results or a
canary is confirmed delivered.

The registered device profile was also checked against the current host and
OpenBubbles defaults. It advertises the host's real `Mac16,10` model, macOS
`26.5.2` / build `25F84`, and IDS protocol version `1660`; the hardware-derived
NAC data, registration metadata, and lookup user agent are internally
consistent. There is no evidence that replacing the device identity would fix
the empty lookup, and doing so would contradict upstream's guidance for a
new-account recipient limit.

The upstream rustpush error contract says new Apple Accounts can initially have
a recipient limit of zero and warns that reconfiguration or reinstallation can
turn a directory limit into a temporary iMessage block. iBlue therefore keeps
the working APNs device, IDS registration, and encrypted credential stable.
Approving a repeated login from a trusted device is not a recovery mechanism:
the successful SMS two-factor flow already satisfied Apple authentication, and
the current failure occurs later at peer-directory lookup. If official
Messages.app on a separate, previously trusted Apple device also cannot stay
signed in or send, use Apple's iMessage activation/support workflow before
making another iBlue registration attempt.

Apple's official activation workflow subsequently emailed on 2026-08-03 that
the secondary Apple Account was ready for iMessage. iBlue therefore preserves
the working device registration and cooldown rather than re-authenticating; the
post-cooldown strict canary remains the test of whether Apple's device-specific
directory response has changed.

If that canary is still empty, it extends the quiet period as usual. Once the
new cooldown fully expires, `registration-refresh --confirm` can republish the
same saved device/APNs/NGM identity without password entry, 2FA, a VM, or
Messages.app. The command has no cooldown bypass, performs no peer-directory
query, never starts the message client, avoids the native resource manager's
registration retry loop, persists the returned service certificates
synchronously, and commits another 72-hour passive period before the remote
operation so even a failure or interruption cannot be retried immediately.
It is a narrower recovery than
logging in again because it does not manufacture a replacement device tuple.

The saved registration can be audited during a cooldown without making that
attempt:

```bash
npm run dev -- registration-inspect --profile secondary
npm run dev -- registration-inspect --profile secondary --json
```

`registration-inspect` starts the native process in an enforced offline-only
mode and calls `account.registration.inspect` directly, without first calling
`system.initialize`. It parses only the serialized IDS users already in the
profile and reads the profile-local software keystore to check that referenced
private keys still exist. It reports redacted service names, sending handles,
protocol versions, registration/renewal timing, public certificate SHA-256
fingerprints, and a hash of the saved state. It never exposes DSIDs, private-key
aliases, certificates, APNs tokens, or account credentials. The offline guard
rejects APNs initialization, login, registration, lookup, and send methods, so
the command cannot consume an IDS retry during a cooldown.

The live secondary profile was inspected this way on 2026-08-03. It contained
one Apple user at IDS protocol 1660, the expected mail handle, all four required
services, every referenced local private key, an active renewal interval of
roughly 45 days, and no warnings. This rules out a missing local service, key,
or expired certificate as the cause of the empty peer-directory response; it
does not rule out an Apple-side account/device throttle. The complete
registration and request comparison is recorded in the
[IDS directory-wire audit](ids-directory-audit.md).

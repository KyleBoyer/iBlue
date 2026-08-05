# IDS registration and directory-wire audit

This note records the evidence used to distinguish a malformed iBlue request
from an Apple-side account/device directory limit. It deliberately contains no
Apple Account identifier, DSID, APNs token, certificate, private-key alias, or
saved-state fingerprint.

Audit snapshot: 2026-08-04.

## Source baseline

- iBlue's prepared rustpush tree is pinned to
  [`b2996d57936ccd72198144685c7837ea01759685`](https://github.com/OpenBubbles/rustpush/tree/b2996d57936ccd72198144685c7837ea01759685),
  with the reviewed iBlue overlay in `rustpush/upstream-iblue.patch`.
- Current OpenBubbles rustpush `master` was
  [`70ec162c6838830194d55792c8b26e4d6681c816`](https://github.com/OpenBubbles/rustpush/tree/70ec162c6838830194d55792c8b26e4d6681c816)
  when this audit was completed.
- The independent comparison is pypush's Python implementation immediately
  before its repository rewrite:
  [`ids/query.py` at `902965a`](https://github.com/JJTech0130/pypush/blob/902965a4108f2d936823f852417701ab96f981fd/ids/query.py).

The iBlue overlay adds a direct-HTTPS diagnostic path and passive receive mode,
but does not replace the normal APNs-tunnel request construction.

## Upstream and fork review

The one commit between iBlue's pinned rustpush revision and the current
[OpenBubbles revision](https://github.com/OpenBubbles/rustpush/compare/b2996d57936ccd72198144685c7837ea01759685...70ec162c6838830194d55792c8b26e4d6681c816)
only adds message serialization derives. It does not change IDS registration,
directory lookup, recipient selection, retry behavior, or message sending.

Active forks were also compared against OpenBubbles rather than assumed to
contain a routing fix. The [Offline-DC fork](https://github.com/Offline-DC/rustpush)
adds diagnostic logging and longer operation timeouts, but its current line
explicitly returns IDS force-refresh handling to upstream behavior; it has no
fix for a successful lookup containing an explicit empty recipient list. The
[hilmiazizi fork](https://github.com/hilmiazizi/rustpush) implements an iPhone
relay/BBOX identity path and alternate delegate-auth pipeline. That is not a
drop-in improvement for this profile: iBlue already has a valid native Mac
registration and working inbound APNs, while adopting that fork would replace
the identity model and introduce device-spoofing behavior. Other recently
updated forks inspected during the audit either had no commits ahead of
OpenBubbles or contained build/submodule changes only.

The 53-fork GitHub network was re-enumerated on 2026-08-03. Two details from the
ahead forks reinforce the current design rather than supplying a new fix:

- Offline-DC explicitly reverted its automatic `validate_targets` and send-time
  force refresh after experimenting with it. iBlue's single-attempt canary and
  durable quiet period avoid the same extra directory traffic.
- hilmiazizi's BBOX lookup constructs a directly signed HTTPS `id-query` from a
  saved identity and APNs token. That is the same independent transport already
  exposed by iBlue's `validate_targets_http`; it previously returned the same
  empty result as the normal APNs tunnel. Its test program also moved software
  anisette state per account and retained the first authenticated
  `AppleAccount` to avoid a second GSA login. iBlue already scopes
  `IBLUE_DATA_DIR`, the process working directory, keystore, and anisette state
  to each profile, and its `LoginSession` carries the first authenticated
  account through 2FA, delegate authentication, and registration.

The review did uncover unsafe native diagnostics in iBlue itself: the login
path printed hardware headers, the APNs token, and the Apple Account identifier
at the default info level. Those values are now omitted; only non-identifying
state and outcome information remains in normal service logs.

[rustpush PR #28](https://github.com/OpenBubbles/rustpush/pull/28) proposes
invalidating cached pair keys for every `messageprotection-*` error. It is an
untested, post-send recovery proposal whose author notes that the error meanings
are inferred and the match may be too broad. iBlue has not adopted it: the
current failure occurs before any send, when the directory returns no target,
so cache invalidation cannot repair it and could cause another avoidable IDS
lookup. A narrow recovery can be revisited if a delivered canary later produces
a concrete message-protection error.

The upstream refs, open issues, and all pull requests were checked again on
2026-08-04. `master` remains `70ec162`; no issue or pull request contains a fix
for successful IDS queries with empty recipient identities. The newer
[rustpush PR #33](https://github.com/OpenBubbles/rustpush/pull/33) updates the
optional remote Anisette v3 dependency for pre-2FA SideStore provisioning and
hardens alias-error parsing. It does not change IDS registration, `id-query`,
recipient fanout, or device reputation. iBlue's supported macOS path uses
AAAbsinthe/AOSKit and its default portable path uses local ClearADI, while the
legacy remote provider already has a state-preserving timeout/panic wrapper, so
the provisioning dependency change is not a Jade canary fix. iBlue did adopt
the independent alias safety hunk: error responses may omit `alias`, and raw
alias response bodies and account handles are no longer written to native logs.

## Offline registration evidence

`registration-inspect` parsed the live secondary profile under the native
process's enforced offline-only mode. It found:

- one Apple IDS user using protocol version 1660;
- the expected `mailto:` sending handle;
- registrations for `com.apple.madrid`,
  `com.apple.private.alloy.multiplex1`,
  `com.apple.private.alloy.facetime.multi`, and `com.apple.ess`;
- an active registration interval with roughly 45 days remaining;
- every referenced authentication and service private key in the profile-local
  software keystore; and
- no structural, service, key, or renewal warning.

That proves the saved local bundle is complete and usable for a Madrid query.
It does not prove that Apple's server still grants the account/device tuple an
outbound recipient allowance.

## APNs directory request comparison

The normal `IDSUser::query` path and independent pypush code agree on every
material part of the request:

| Element | iBlue / rustpush | Independent pypush |
| --- | --- | --- |
| Bag key | `id-query` | `id-query` |
| Body before compression | XML plist `{ uris: [...] }` | XML plist `{ uris: [...] }` |
| Compression | Deterministic gzip | Deterministic gzip |
| Self header | `x-id-self-uri` | `x-id-self-uri` |
| Protocol header | `x-protocol-version` | `x-protocol-version` |
| Authentication | IDS service certificate signature bound to APNs token | IDS service certificate signature bound to APNs token |
| APNs content type | `application/x-apple-plist` | `application/x-apple-plist` |
| Tunnel command | `c = 96` | `c = 96` |
| Tunnel version | `v = 2` | `v = 2` |
| Correlation | random 16-byte `U`, matched in response | random 16-byte `U`, matched in response |
| Envelope fields | `cT`, `U`, `c`, `u`, `h`, `v`, `b` | `cT`, `U`, `c`, `u`, `h`, `v`, `b` |
| Response | gzip `b`, then plist status/results | gzip `b`, then plist status/results |

The tunnel intentionally does not add an HTTP `content-encoding` header. The
gzip bytes are the APNs envelope's `b` field, exactly as in pypush. The separate
direct-HTTPS diagnostic correctly adds `content-type`, `content-encoding`, and
`accept-encoding` because it is an actual HTTP POST.

rustpush signs the IDS nonce, bag key, empty query string, compressed body, and
raw APNs token. The Madrid service registration certificate signs the request;
the account authentication certificate is not incorrectly substituted.

## Sender and query-option selection

The identity manager:

- serializes directory requests behind one query lock;
- selects the IDS user that owns the requested sender handle;
- signs with the main service certificate when querying a sub-service;
- chunks requests at no more than 18 addresses; and
- uses one canonical address supplied by `ids-probe`, without adding the
  profile's own handles or silently trying a second transport.

That one-address probe remains the pure directory diagnostic. The guarded first
outbound test uses `ids-canary` instead. A real text send adds the selected
sender handle for same-account device fanout, so the canary deliberately queries
the one recipient plus that sender in a single APNs request. The native child
disables rustpush's internal failed-query retry, and the canary calls the cache
lookup directly rather than using the general panic guard that can bisect a
multi-address batch. It also keeps receive handling passive during the test, so
an incoming push cannot trigger an unrelated sender lookup. It sends only when
both addresses have fresh identities that were created or replaced by this
specific response in the same native process. This avoids a second pre-send
query, rustpush's historical immediate `NoValidTargets` refresh loop, and false
authorization from an older positive cache entry.

The strict report distinguishes four negative shapes without another request:

- `explicit-empty`: Apple returned a per-address entry with zero identities;
- `omitted`: the response did not create or replace that address's cache entry;
- `error`, `timeout`, or `panic`: the lookup did not complete successfully; and
- `stale`: an entry exists but is not usable as fresh evidence.

All four fail closed and write the durable backoff. A correlation identifier is
reported only as a presence boolean; no Apple token, ID, certificate, or key is
exposed through JSON-RPC.

The ordinary availability endpoint uses `QueryOptions::default()`, so it omits
`x-required-for-message` and `x-result-expected`. The actual outbound target
resolution path sets both headers to `true`. A live message-required forced
refresh also returned a successful IDS response containing zero recipient
identities. The empty result therefore is not explained by the availability
probe omitting those two headers.

## Live observations and conclusion

The secondary profile has received and decrypted text, typing state, a JPEG,
a `haha` tapback, and a sticker. APNs delivery and the registered inbound
identity are therefore functional. Both the normal APNs lookup path and a
message-required refresh received valid protocol responses but zero peer
identities, including for a known-good phone handle.

On 2026-08-03, after using Apple's official iMessage/FaceTime account
activation workflow, Apple emailed that the secondary Apple Account was ready
for iMessage. Apple documents that exact email as the successful result of its
[online Enable Apple Account workflow](https://support.apple.com/en-us/108791).
That is direct evidence that the account-level iMessage activation gate is now
open. It does not by itself prove that the already-registered iBlue device tuple
has received a nonzero peer-directory allowance, so the stable registration
remains untouched until the scheduled strict canary.

The audited request agrees with current rustpush and independent pypush, and the
offline registration bundle is complete. No known body, header, signature,
certificate-selection, tunnel-envelope, sender-handle, or query-option defect
currently explains the result. The leading hypothesis is an Apple-side
recipient/directory limit on the account/device tuple. This is consistent with
[rustpush's explicit new-account zero-recipient warning](https://github.com/OpenBubbles/rustpush/commit/7685b827d7deaf07bf33cb961c889995f916573b)
and [OpenBubbles' throttling guidance](https://openbubbles.app/docs/faq.html#why-are-contacts-i-know-are-using-imessage-showing-up-green).

This is evidence, not certainty. The discriminator after cooldown is one APNs
request for a canonical, known-good `tel:+...` recipient and the registered
sending identity through `ids-canary`. If both are available, the command sends
one plain-text canary from the same fresh cache, persists its outgoing GUID,
and waits on the existing APNs connection for a correlated delivery, read, or
send-error control. APNs acceptance without a receipt is explicitly not called
delivery. Immediately before the lookup, iBlue writes an owner-only passive
hold and canary journal; the journal stores a SHA-256 digest instead of message
plaintext and prevents an interrupted or completed attempt from being repeated.
`ids-canary-status` reads that journal plus any late receipt in the local message
database without starting native code, APNs, credential access, or an Apple
request. Any incomplete response sends nothing and automatically extends
iBlue's passive policy by 72 hours. Internal
directory retry, panic bisection, fallback transport, and inbound sender lookup
are all disabled for that invocation. If
official Messages on physical Apple hardware succeeds while the stable iBlue
identity remains empty after that backoff, investigation should return to
device eligibility and unobserved Apple-client request differences rather than
account reputation.

## Bounded registration recovery

Re-entering the Apple password and 2FA is not the next recovery step. If the
post-activation canary is still empty, it writes another 72-hour quiet policy.
After that policy fully expires, iBlue has a narrower recovery command:

```bash
npm run dev -- registration-refresh --profile secondary --confirm
```

The command is deliberately unavailable with no prior cooldown record, refuses
to bypass an active cooldown, and requires `--confirm`. It does not start the
message client, makes one bounded registration operation with no
resource-manager retry, and performs no recipient/sender directory lookup. It
reuses the profile's device ID, APNs identity, account authentication material,
and NGM keys; it does not ask for a password or verification code, create a new
device identity, use a VM, or touch Messages.app. The refreshed service
certificates are synchronously copied back into `session.json` before shutdown.

The command writes another 72-hour passive policy before issuing the remote
refresh, so success, failure, timeout, or interruption cannot be followed by an
immediate retry. Only after that new quiet period expires should the same one-recipient
`ids-canary` be tried again. This yields a controlled discriminator between an
account activation that merely needed the existing device registration
republished and a persistent device eligibility/directory restriction.

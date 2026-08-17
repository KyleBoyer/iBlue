# FaceTime media key exchange audit

Audit date: 2026-08-17 (America/Chicago). Repository commit at audit:
`1484230` (`Keep FaceTime media diagnostics on by default`).

Written to answer one question: **why does a call from an older iOS peer fail
where a modern iPhone works?** It compares iBlue's media key exchange against
the newest upstream reverse engineering of the same Apple protocol, marks every
place where iBlue's behaviour is narrower than upstream's, and ranks those gaps
by how likely each is to explain a failed call from an older peer.

## What was compared, and what was not

| Source | Revision | Role |
| --- | --- | --- |
| iBlue's engine | `third_party/rustpush-upstream` @ `b7a3b45` (`ft-testing`, April 2026) plus the patch stack in `rustpush/` (63 patches, including the one this audit adds) | What we ship |
| Upstream rustpush `main` | `106d09c` (2026-08-14), FaceTime rewritten into `src/avconference.rs` | Newest independent implementation of the same protocol |
| OpenBubbles `rtc` | `8758966` | SRTP/MKI wire behaviour, shared by both |

Apple binaries were **not** examined. This audit ran in a Linux container with
no dyld shared cache, no IPSW, and no `ipsw` tool, so `callservicesd`,
`AVConference`, and `IDSFoundation` could not be disassembled for this pass.
Everything below is source-level evidence from the three checkouts above.

No log from the failing call was attached to this task either, so the
hypotheses below are ranked, not confirmed. The last two sections exist to
settle them: a diagnostic patch that records what a peer actually advertises,
and the exact greps to run after the next attempt.

Line references point at the generated tree `third_party/rustpush-upstream/`,
which `npm run prepare:native` produces from the pin plus `rustpush/*.patch`.
That tree is not in Git, and the numbers move whenever the stack changes; the
durable sources are the pin and `rustpush/*.patch`.

## How iBlue exchanges media keys today

1. **Prekey.** Each session generates a P-256 keypair
   (`src/ids/link.rs:3941`). The public point is advertised two ways: inline in
   the IDS invitation as `rtmpk` with `rtmpwm = 1`
   (`src/facetime.rs:1683`, `src/facetime.rs:2824`), and as a signed QuickRelay
   material of type 11 (`src/ids/link.rs:3733`), signed under
   `com.apple.FaceTime.QRKeying`.
2. **Own key material.** `QuickRelayMkmMaterial::create`
   (`src/ids/link.rs:660`) builds a 16-byte MKI, a 32-byte master key, a
   16-byte salt, `mkgc = 1`, and `smkil = 2`. The MKI is
   `0x0010 || pid[63:32] || 0x00 || pid[31:0] || 0*5`
   (`apple_rtp_mki`, `src/ids/link.rs:613`), which is the same 16 bytes
   upstream produces from `MKIShortFormat { roll_index: 1, ratchet_index: 0 }`.
   `QuickRelaySkmMaterial::create` (`src/ids/link.rs:558`) is the session
   equivalent and protects the AVC blob.
3. **Wrapping.** `QuickRelayPreKey::encrypt_key_material`
   (`src/ids/link.rs:497`): ephemeral P-256 ECDH against the peer prekey,
   HKDF-SHA256 with info `"GFT-MKM-Wrapping" || peer_pub[1..65] ||
   ephemeral_pub[1..]`, then AES-256 key wrap. The ciphertext is
   `ephemeral_pub || wrapped`. `GlobalLinkState::decode_key_material`
   (`src/ids/link.rs:1303`) is the mirror image.
4. **Publication.** `bootstrap_session` (`src/ids/link.rs:2095`) wraps our MKM
   and SKM once per participant that already has a prekey and PUTs them as
   QuickRelay material types 13 and 14 with `short_material_id_length: 0`,
   caching the exact ciphertext in `ParticipantState::outgoing_key_material`
   (`facetime-native-incoming-key-material.patch`). The answering path mirrors
   the same bytes over IDS command 211 (`src/facetime.rs:2887`), and
   `republish_outgoing_key_materials` (`src/ids/link.rs:3416`) re-sends them
   when a peer's command 210/211 arrives later.
5. **Import.** QuickRelay types 11/12/13/14 land in `handle_new_materal`
   (`src/ids/link.rs:1966`); command 211 lands in `import_peer_key_material`
   (`src/ids/link.rs:3300`). Both unwrap with our prekey and register the
   peer's current MKM plus two ratchets (`current_and_next(..., 3)`).
6. **Derivation.** Control keys come from the MKM with info
   `"VCControlChannelV2" || my_uuid || their_uuid` (`src/ids/link.rs:716`);
   SRTP master material is `HKDF(mks, mkm)` over the little-endian SSRC
   (`src/ids/link.rs:730`); the AVC blob key is the SKM expanded over
   `"<relay session id>datablob-context"` (`src/ids/link.rs:844`).
7. **On the wire.** `rtc-srtp` appends a fixed two-byte MKI `00 10` to every
   outbound packet and strips two bytes on inbound
   (`rtc-srtp/src/cipher/cipher_aes_cm_hmac_sha1/mod.rs:69`). It also handles
   the four-byte ROC trailer Apple adds to every 128th packet.

That much matches upstream byte for byte. The divergences are in *when* keys
are published, *which* key is chosen for an inbound packet, and *what media
shapes* are accepted at all.

## Divergences from upstream `main`

| # | Upstream `main` | iBlue | Consequence |
| --- | --- | --- | --- |
| 1 | `handle_prekey` → `ensure_keys` publishes our wrapped MKM/SKM to that participant the moment its prekey arrives, on any path, at any time (`avconference.rs:3406`, `avconference.rs:676`) | The type-11 handler only stores the prekey (`link.rs:2016`); publication happens in the one-shot `bootstrap_session`, which returns early once `bootstrapped` is set (`link.rs:2099`), or in `republish_outgoing_key_materials` when an IDS command 210/211 arrives | A peer whose prekey lands **after** bootstrap, and which never sends a prekey-bearing 210 or a 211, never receives our keys. It cannot decrypt our control ACKs or our media, and it sits on **Connecting…** while retransmitting `DeviceState` |
| 2 | Inbound SRTP context is keyed by `(SSRC, MKI)` and looks the key up by the MKI carried in the packet (`avconference.rs:1561`); packets that arrive before the keys are buffered for 5 s and replayed (`SSRCState::Waiting`) | One context per SSRC, built from `state.states.iter().find_map(\|i\| i.1.mkm.first())` — an arbitrary participant's first key — and cached for the life of the call (`src/facetime.rs:1875`) | Wrong key whenever more than one peer or more than one generation exists; permanently wrong after a peer ratchets its MKI (`0x0010` → `0x0011`); early packets are dropped instead of replayed |
| 3 | Protection profile is chosen per SSRC: `Aes128CmMkiNoAuth` for group streams, HMAC profiles only for one-to-one (`avconference.rs:1568`), and the MKI offset differs between the two (`avconference.rs:1494`) | Profile is chosen from the payload type alone and is always an HMAC profile (`src/facetime.rs:1884`) | If a call runs with group media semantics rather than U+1 one-to-one, every inbound packet fails authentication and our outbound packets carry a tag the peer does not expect |
| 4 | H.264 is payload type 123 with a real depacketizer (`avconference.rs:71`, `AVSessionCodec::H264`) | Our AVC blob offers payload 123 *and* 100 (`src/facetime.rs:729`), but only payload 100 gets a depacketizer (`src/facetime.rs:1887`) and only HEVC is ever sent | A peer that selects H.264 gets no video from us, and its video is decrypted and then discarded |
| 5 | Peer feature flags are negotiated per payload from the peer's blob (`avconference.rs:738`) | Inbound frames are parsed with a hardcoded feature set `"FLS2;RVRA1;CH1;CR;CF;FA;"` (`src/facetime.rs:1730`) | A peer that negotiates a smaller feature set has its payload headers mis-parsed |
| 6 | Packet dispatch: anything with the high bit clear is control, RTCP by second byte, everything else parsed as RTP (`avconference.rs:1737`) | `match recv.data[0] { 0x90 => …, 0x40 => … }` (`src/facetime.rs:1867`) | RTP without the extension bit (`0x80`) is silently discarded |
| 7 | Peer wrap mode is stored as advertised (`avconference.rs:897`) | `seed_participant_prekey` hardcodes `wrap_mode: 1` and the wire handler ignores `rtmpwm` entirely (`src/ids/link.rs:3176`, `src/facetime.rs:3445`) | A peer advertising any other wrap mode is wrapped for incorrectly, and its material fails to unwrap |
| 8 | — | `validate_signed_data` panics on an unexpected session id, an unknown participant, or a missing token (`src/ids/link.rs:1905`) | Unexpected material from a device we have no allocation for takes down the link task rather than being skipped |

Items 1 through 4 are the ones that can plausibly turn a working call into a
dead one. Items 5 through 8 degrade or crash under the same conditions.

## Ranked hypotheses for the failing call

### 1. The incoming-call readiness gate depends on IDS side-channel behaviour the peer may not have

`native_media_ready` (`src/facetime.rs:2222`) refuses to report readiness for a
call we answered until `native_command211_republished` is non-empty. That set is
only populated when the peer sends a command 211 carrying key material, or a
command 210 carrying an inline `rtmpk` prekey
(`facetime-native-incoming-key-readiness.patch`,
`facetime-native-command211-reciprocal-keys.patch`). A peer that publishes its
prekey only as QuickRelay type-11 material — the path upstream treats as the
primary one — never satisfies the gate.

Expected signature: the call is answered, the relay connects, and the responder
never starts media. `Imported FaceTime IDS key material` and
`Re-published reciprocal FaceTime responder keys after command-21x` are both
absent from the log.

Fix: make readiness depend on the state that actually matters — this
participant has our keys and we have theirs — rather than on which transport
delivered them.

### 2. Our key publication is one-shot; upstream's is per-participant and continuous

Divergence 1 above. This is the same failure seen from the other side: not that
we cannot read the peer, but that the peer cannot read us. It matches the
"stalled call" signature already recorded in the handoff doc — only repeated
`DeviceState` and `GenerateKeyFrame`, never `StreamGroupsState` — because the
peer cannot authenticate our control channel.

An older peer changes the ordering in exactly the way that exposes this: its
prekey arrives on a different transport, or later, than the modern iPhone the
patch stack was tuned against.

Fix: port upstream's `ensure_keys`. On every prekey arrival — QuickRelay type 11
included — wrap and publish this side's MKM/SKM for that participant if it has
not been sent, instead of relying on `bootstrap_session` having already run.

### 3. The peer negotiated H.264, which we neither send nor depacketize

Divergence 4. Video codec choice is the most version-correlated thing in the
whole negotiation: our blob advertises H.264 as payload 123, and an older
device is exactly the kind of peer that selects it. Audio would be unaffected,
so the call would look alive but blank.

Expected signature: `FaceTime inbound payload type not recognised for
templating: … payload_type=123` (that line exists today, from
`facetime-native-diagnostics-default-on.patch`), and no video frames.

### 4. The call ran with group media semantics rather than U+1

Divergence 3. iBlue advertises `one_to_one_mode_supported: true`
(`src/facetime.rs:1023`) and mirrors the peer's
`is_gft_downgrade_to_one_to_one_available` back at it, but never handles the
`OneToOneEnabledState` control message that upstream uses to actually enter or
leave U+1 (`avconference.rs:3628`, `set_u1`). If the peer stays in group mode,
its media uses `Aes128CmMkiNoAuth` and an MKI at a different offset, and none
of it decrypts.

Expected signature: `FaceTime inbound media datagram:` lines present (bytes are
arriving) with no `FaceTime inbound audio template:` line and repeated decrypt
errors.

### 5. A rekey mid-call

Divergence 2. Key material is published with a 605-second expiry
(`src/facetime.rs:2891`) and command 210 is the periodic rekey. Because the
inbound context is built once per SSRC from `mkm.first()`, a peer that ratchets
its MKI mid-call is never followed. This one is call-duration dependent rather
than version dependent, so it ranks below the others — but it produces the same
"media stopped" report.

### 6. A different prekey wrap mode

Divergence 7. Cheap to rule in or out: the log line
`Ignoring FaceTime MKM that was not wrapped for this QuickRelay participant`
(`src/ids/link.rs:2043`) fires when the peer's material does not unwrap with
our prekey.

## Added by this audit: peer version and key-parameter diagnostics

`rustpush/facetime-native-peer-version-diagnostics.patch` (last in the stack in
`scripts/prepare-rustpush.mjs`) records what a peer actually is and what it
advertises. Nothing about the exchange changes; two log lines are added, both
behind the existing `media_diagnostics_enabled()` switch, and neither prints key
bytes.

`FaceTime peer client:` is emitted where the invitation's AVC blob is already
decoded, and carries the peer's `device_type`, `os_version`,
`framework_version`, and `client_version` from its call-info blob, its
`blob_version` and `media_control_info_version`, whether it claims
`one_to_one_mode_supported`, the RTP payload types it offered, and whether the
invitation carried a prekey and under which wrap mode. That answers the version
question directly: the peer's own OS build, from its own blob.

`FaceTime peer key material:` is emitted for each prekey, MKM, and SKM the peer
publishes, on both transports (`source=quickrelay` and `source=command-211`),
and carries the wrap mode, the two-byte short MKI, the MKI length, the
advertised `smkil`, and the generation counter. Those are exactly the fields
divergences 2, 5, and 7 above turn on.

## What to capture on the next attempt

Diagnostics default to on (`media_diagnostics_enabled`, `src/ids/link.rs:1066`).
After the call, in order:

```bash
LOG="$HOME/Library/Logs/iBlue/serve.error.log"

# 1. Who the peer is and what it offered (added by this audit)
rg -n 'FaceTime peer client:|FaceTime peer key material:' "$LOG" | tail -n 20

# 2. Did we ever exchange keys with it?
rg -n 'Imported FaceTime IDS key material|Re-published reciprocal|Seeded FaceTime (peer|device) prekey|Participant missing prekey|waiting for a peer prekey' "$LOG" | tail -n 40

# 3. Did its material unwrap?
rg -n 'not wrapped for this QuickRelay participant|No SKM!|No MKM' "$LOG" | tail -n 20

# 4. Did media arrive, and in what shape?
rg -n 'inbound media datagram|inbound audio template|payload type not recognised' "$LOG" | tail -n 30

# 5. Did the control channel ever advance?
rg -n 'StreamGroupsState|DeviceState|GenerateKeyFrame' "$LOG" | tail -n 40
```

Read them as a decision tree:

- Peer client line shows an older `os_version` and section 2 is empty →
  hypothesis 1 or 2.
- Section 2 shows imports but section 4 shows datagrams with no template →
  hypothesis 4.
- Section 4 shows `payload_type=123` → hypothesis 3.
- Section 3 fires → hypothesis 6.
- Everything healthy for the first minutes and then silence → hypothesis 5.

## Recommended changes, in order

1. **Publish key material per participant on prekey arrival**
   (upstream `ensure_keys`). Removes the ordering dependency that hypotheses 1
   and 2 both rest on, and makes the command-211 republish machinery a
   redundancy rather than the mechanism.
2. **Key inbound SRTP contexts by `(SSRC, MKI)` and select the peer's MKM by
   the MKI in the packet**, buffering packets briefly until the matching key is
   known. Directly ports `avconference.rs:1561`.
3. **Base readiness on key state, not on which command delivered it.**
4. **Accept H.264**: depacketize payload 123 inbound, and decide deliberately
   whether to keep advertising it outbound while only HEVC is sent.
5. **Honour the peer's `rtmpwm`** rather than assuming mode 1, and log a
   distinct warning when it is anything else.
6. **Replace the panics in `validate_signed_data` with skips.**

Items 1 through 3 are the ones that would change the outcome of the call this
audit was opened for.

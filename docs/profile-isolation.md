# Same-user Apple Account isolation

iBlue does not sign Messages.app in, automate its UI, load `chat.db`, or use a
private framework inside the Messages process. Its Apple Account is represented
by an independent IDS/APNs registration owned by an iBlue profile. This allows
the secondary account and the user's normal Messages.app account to coexist in
the same macOS login without disabling SIP or creating another macOS user.

## Isolation boundary

| State | Isolation mechanism |
| --- | --- |
| TypeScript session and IDS policy | `<data-root>/profiles/<profile>/session.json` and `ids-policy.json` |
| BlueBubbles-compatible history | A per-profile `iblue.sqlite` database and WAL files |
| Downloaded and uploaded media | A per-profile `attachments/` tree |
| Native APNs/IDS keys and registrations | The native child receives the profile's canonical absolute path through both `--state-dir` and `IBLUE_DATA_DIR`; keystore, anisette, IDS key-cache, and subsystem paths are anchored below it |
| Apple Account credential | An OS-credential item or profile-bound AES-256-GCM `credentials.enc` file keyed by an opaque `app.iblue.ids.*` service identity persisted at `<profile>/native/credential-service` |
| Concurrent ownership | A SQLite exclusive lease prevents two native processes from opening the same profile; the OS releases it after clean exit or a crash |

The profile name grammar rejects absolute paths, separators, leading dots, and
parent traversal. TypeScript resolves the data root to an absolute path. The
native executable then canonicalizes its own state directory. On the first
upgraded run it derives the same legacy path-hashed credential service already
used by that profile and atomically persists it in an owner-only
`credential-service` file. Later runs load that opaque value instead of deriving
another one from the current path. Two independently created profile paths
therefore retain different credential namespaces, native key caches,
registrations, message databases, and attachment trees, while intentionally
moving a complete profile to another host path preserves its encrypted
credential authentication context.

The real Mac's hardware facts are intentionally common to processes running on
that Mac. Apple's native validation framework expects them, and replacing them
would make the registration less internally consistent. They are not the
account boundary: each profile retains its own APNs certificate/token, IDS
authentication keys, NGM identity, service registrations, peer-key cache, and
Apple Account credential.

## Messages.app boundary

iBlue has no code path for `~/Library/Messages`, `chat.db`, Messages.app
preferences, AppleScript, Accessibility automation, or SIP-protected injection.
The API and local history are built from push events received by iBlue's own
APNs connection. Signing in or logging out an iBlue profile does not call the
Messages.app account UI.

On 2026-08-03, the live secondary-profile server was audited while receiving
text, typing, JPEG, tapback, and sticker events. Its processes held no open file
under `~/Library/Messages`; a before/after smoke test also left `chat.db` and
`com.apple.iChat.plist` inode, size, and timestamps unchanged. The profile's
Keychain metadata used only the custom, profile-scoped `app.iblue.ids.*` service
and the fixed `ids-account` item account, rather than an Apple Messages
credential service. Messages.app was not running during the later open-file
snapshot, so that snapshot proves iBlue's file boundary, not simultaneous UI
activity.

## Enforced regressions

Offline tests assert that:

- every sensitive TypeScript path differs between two profiles and remains
  beneath the selected profile root;
- invalid profile names cannot escape the data root;
- the native child receives the selected directory as both cwd and
  `IBLUE_DATA_DIR`;
- the IDS key cache and legacy keystore migration source are explicitly rooted
  under that directory instead of the caller's cwd;
- credential service names are stable, opaque, and distinct for independently
  created profile paths;
- the persisted credential service and AES-GCM ciphertext remain usable after
  the complete native profile directory moves to another absolute path; and
- a second process cannot acquire an already-running profile but can acquire it
  after the first process exits.

These checks are platform-neutral except for the OS credential implementation.
macOS uses Keychain, Windows uses Credential Manager, and Linux uses Secret
Service; the encrypted-file alternative binds its ciphertext to the same
persisted profile service identity as authenticated additional data.

## Remaining live gate

Inbound isolation is verified. Outbound delivery is not yet verified because
Apple returned empty IDS peer-directory results for the newly activated test
account. Apple's activation email confirms the account is enabled for iMessage,
but it does not prove that this saved device registration now receives peer
identities. The first post-cooldown `ids-canary` remains the deliberately single
live test; no re-login or replacement identity is warranted before that result.

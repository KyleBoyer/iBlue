import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const thirdPartyRoot = join(projectRoot, "third_party");
const rustpushRoot = join(thirdPartyRoot, "rustpush-upstream");
const rustlsRoot = join(thirdPartyRoot, "rustls-psk");
const quinnRoot = join(thirdPartyRoot, "quinn-qpod");
const rtcRoot = join(thirdPartyRoot, "rtc-openbubbles");
const applePrivateApisRoot = join(rustpushRoot, "apple-private-apis");
const pin = readFileSync(join(thirdPartyRoot, "rustpush-upstream.sha"), "utf8").trim();
const rustlsPin = "829d6c4db64afac5eabbba2e6cf00443294419f7";
const quinnPin = "bb2c42e08d2f8073cb3c377bab2ab29f5615ea3e";
const rtcPin = "875896651675726ed2edc68a7030f1bc7e88b88e";

if (!pin) throw new Error("third_party/rustpush-upstream.sha is empty");
mkdirSync(thirdPartyRoot, { recursive: true });

if (!existsSync(join(rustpushRoot, ".git"))) {
  if (existsSync(rustpushRoot) && readdirSync(rustpushRoot).length > 0) {
    throw new Error(`${rustpushRoot} exists but is not a Git checkout; move it aside and retry`);
  }
  git(["clone", "https://github.com/OpenBubbles/rustpush.git", rustpushRoot], projectRoot);
  git(["checkout", pin], rustpushRoot);
} else {
  const current = gitOutput(["rev-parse", "HEAD"], rustpushRoot);
  if (current !== pin) {
    throw new Error(`rustpush checkout is ${current}; expected pinned commit ${pin}`);
  }
}

git(["submodule", "update", "--init", "--recursive", "apple-private-apis"], rustpushRoot);
applyPatchStack(rustpushRoot, [
  join(projectRoot, "rustpush", "upstream-iblue.patch"),
  join(projectRoot, "rustpush", "sticker-messages.patch"),
  join(projectRoot, "rustpush", "posterkit-transcript-background.patch"),
  join(projectRoot, "rustpush", "keyed-archive-components.patch"),
  join(projectRoot, "rustpush", "native-facetime-media.patch"),
  join(projectRoot, "rustpush", "headless-facetime-media.patch"),
  join(projectRoot, "rustpush", "facetime-native-readiness.patch"),
  join(projectRoot, "rustpush", "facetime-native-audio.patch"),
  join(projectRoot, "rustpush", "facetime-native-rtp-extensions.patch"),
  join(projectRoot, "rustpush", "facetime-native-rtp-routing-diagnostics.patch"),
  join(projectRoot, "rustpush", "facetime-native-media-wire-trace.patch"),
  join(projectRoot, "rustpush", "facetime-native-audio-negotiation-route.patch"),
  join(projectRoot, "rustpush", "facetime-native-audio-codec-framing.patch"),
  join(projectRoot, "rustpush", "facetime-native-control.patch"),
  join(projectRoot, "rustpush", "facetime-native-control-status.patch"),
  join(projectRoot, "rustpush", "facetime-native-inbound-capture.patch"),
  join(projectRoot, "rustpush", "facetime-native-inbound-video-capture.patch"),
  join(projectRoot, "rustpush", "facetime-native-audio-feedback-status.patch"),
  join(projectRoot, "rustpush", "facetime-native-evs-audio.patch"),
  join(projectRoot, "rustpush", "facetime-native-audio-observability.patch"),
  join(projectRoot, "rustpush", "facetime-native-srtp-mki.patch"),
  join(projectRoot, "rustpush", "facetime-native-media-events.patch"),
  join(projectRoot, "rustpush", "facetime-native-control-interop.patch"),
  join(projectRoot, "rustpush", "quickrelay-rustls.patch"),
  join(projectRoot, "rustpush", "facetime-av-feature-fix.patch"),
  join(projectRoot, "rustpush", "facetime-native-live-audio.patch"),
  join(projectRoot, "rustpush", "facetime-native-video.patch"),
  join(projectRoot, "rustpush", "facetime-native-incoming.patch"),
  join(projectRoot, "rustpush", "facetime-native-live-video.patch"),
  join(projectRoot, "rustpush", "facetime-native-incoming-bootstrap.patch"),
  join(projectRoot, "rustpush", "facetime-native-audio-template-fallback.patch"),
  join(projectRoot, "rustpush", "facetime-native-send-readiness.patch"),
  join(projectRoot, "rustpush", "facetime-native-direct-stun-route.patch"),
  join(projectRoot, "rustpush", "facetime-native-incoming-scope.patch"),
  join(projectRoot, "rustpush", "facetime-native-incoming-key-material.patch"),
  join(projectRoot, "rustpush", "facetime-native-incoming-device-token.patch"),
  join(projectRoot, "rustpush", "facetime-native-control-diagnostics.patch"),
  join(projectRoot, "rustpush", "facetime-native-incoming-key-order.patch"),
  join(projectRoot, "rustpush", "facetime-native-incoming-key-republish.patch"),
  join(projectRoot, "rustpush", "facetime-native-incoming-peer-key-material.patch"),
  join(projectRoot, "rustpush", "facetime-native-late-peer-keys.patch"),
  join(projectRoot, "rustpush", "facetime-native-device-prekeys.patch"),
  join(projectRoot, "rustpush", "facetime-native-command211-reciprocal-keys.patch"),
  join(projectRoot, "rustpush", "facetime-native-incoming-key-readiness.patch"),
  join(projectRoot, "rustpush", "facetime-native-session-role.patch"),
  join(projectRoot, "rustpush", "facetime-native-reliable-control.patch"),
  join(projectRoot, "rustpush", "facetime-native-device-session-ids.patch"),
  join(projectRoot, "rustpush", "facetime-native-unknown-device-participant.patch"),
  join(projectRoot, "rustpush", "facetime-native-av-sync.patch"),
]);
applyPatch(applePrivateApisRoot, join(projectRoot, "rustpush", "apple-private-apis-iblue.patch"));

// QuickRelay uses TLS 1.3 external PSKs. Keep that public rustls work pinned,
// then layer the later public selected-ALPN switch needed by Apple's APNs
// protocol suffixes. Cargo consumes this checkout through a local path patch.
if (!existsSync(join(rustlsRoot, ".git"))) {
  if (existsSync(rustlsRoot) && readdirSync(rustlsRoot).length > 0) {
    throw new Error(`${rustlsRoot} exists but is not a Git checkout; move it aside and retry`);
  }
  git(["clone", "https://github.com/TaeHagen/rustls.git", rustlsRoot], projectRoot);
  git(["checkout", rustlsPin], rustlsRoot);
} else {
  const current = gitOutput(["rev-parse", "HEAD"], rustlsRoot);
  if (current !== rustlsPin) {
    throw new Error(`rustls PSK checkout is ${current}; expected pinned commit ${rustlsPin}`);
  }
}
applyPatch(rustlsRoot, join(projectRoot, "rustpush", "rustls-selected-alpn.patch"));
applyPatch(rustlsRoot, join(projectRoot, "rustpush", "rustls-psk-store.patch"));
applyPatch(rustlsRoot, join(projectRoot, "rustpush", "rustls-external-psk-binder.patch"));

// Apple's AVC and IDS channels are QUIC packet-oblivious datagram (QPod)
// children of the authenticated relay connection. Pin OpenBubbles' public
// Quinn implementation and only replace its developer-local dependency paths.
if (!existsSync(join(quinnRoot, ".git"))) {
  if (existsSync(quinnRoot) && readdirSync(quinnRoot).length > 0) {
    throw new Error(`${quinnRoot} exists but is not a Git checkout; move it aside and retry`);
  }
  git(["clone", "https://github.com/OpenBubbles/quinn.git", quinnRoot], projectRoot);
  git(["checkout", quinnPin], quinnRoot);
} else {
  const current = gitOutput(["rev-parse", "HEAD"], quinnRoot);
  if (current !== quinnPin) {
    throw new Error(`QuickRelay Quinn checkout is ${current}; expected pinned commit ${quinnPin}`);
  }
}
applyPatch(quinnRoot, join(projectRoot, "rustpush", "quinn-qpod-dependencies.patch"));

// Pin the public OpenBubbles WebRTC primitives used by the native FaceTime
// transport for STUN, RTP, SRTP, and media packet assembly.
if (!existsSync(join(rtcRoot, ".git"))) {
  if (existsSync(rtcRoot) && readdirSync(rtcRoot).length > 0) {
    throw new Error(`${rtcRoot} exists but is not a Git checkout; move it aside and retry`);
  }
  git(["clone", "https://github.com/OpenBubbles/rtc.git", rtcRoot], projectRoot);
  git(["checkout", rtcPin], rtcRoot);
} else {
  const current = gitOutput(["rev-parse", "HEAD"], rtcRoot);
  if (current !== rtcPin) {
    throw new Error(`OpenBubbles RTC checkout is ${current}; expected pinned commit ${rtcPin}`);
  }
}

const openAbsintheTarget = join(rustpushRoot, "open-absinthe");
rmSync(openAbsintheTarget, { recursive: true, force: true });
cpSync(join(projectRoot, "rustpush", "open-absinthe"), openAbsintheTarget, { recursive: true });

const fairplayRoot = join(rustpushRoot, "certs", "fairplay");
mkdirSync(fairplayRoot, { recursive: true });
const legacyRoot = join(rustpushRoot, "certs", "legacy-fairplay");
const fairplayIdentifiers = [
  "4056631661436364584235346952193",
  "4056631661436364584235346952194",
  "4056631661436364584235346952195",
  "4056631661436364584235346952196",
  "4056631661436364584235346952197",
  "4056631661436364584235346952198",
  "4056631661436364584235346952199",
  "4056631661436364584235346952200",
  "4056631661436364584235346952201",
  "4056631661436364584235346952208",
];
for (const identifier of fairplayIdentifiers) {
  cpSync(join(legacyRoot, "fairplay.crt"), join(fairplayRoot, `${identifier}.crt`));
  cpSync(join(legacyRoot, "fairplay.pem"), join(fairplayRoot, `${identifier}.pem`));
}

function git(args, cwd) {
  const result = spawnSync("git", ["-c", "url.https://github.com/.insteadOf=git@github.com:", ...args], {
    cwd,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed with status ${result.status}`);
}

function gitOutput(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function applyPatch(cwd, patchPath) {
  if (gitCheck(["apply", "--check", patchPath], cwd)) {
    git(["apply", patchPath], cwd);
    return;
  }
  if (!gitCheck(["apply", "--reverse", "--check", patchPath], cwd)) {
    throw new Error(`cannot apply or recognize existing patch ${patchPath}`);
  }
}

// A later patch may add lines immediately after a hunk from an earlier patch,
// which prevents `git apply --reverse --check` from recognizing the earlier
// patch on an already-prepared checkout. Peel off every recognizable patch in
// reverse order, then reapply the whole stack in its canonical order.
function applyPatchStack(cwd, patchPaths) {
  for (const patchPath of [...patchPaths].reverse()) {
    if (gitCheck(["apply", "--reverse", "--check", patchPath], cwd)) {
      git(["apply", "--reverse", patchPath], cwd);
    }
  }
  for (const patchPath of patchPaths) applyPatch(cwd, patchPath);
}

function gitCheck(args, cwd) {
  return spawnSync("git", args, { cwd, stdio: "ignore", shell: false }).status === 0;
}

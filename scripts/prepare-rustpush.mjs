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
const applePrivateApisRoot = join(rustpushRoot, "apple-private-apis");
const pin = readFileSync(join(thirdPartyRoot, "rustpush-upstream.sha"), "utf8").trim();

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
]);
applyPatch(applePrivateApisRoot, join(projectRoot, "rustpush", "apple-private-apis-iblue.patch"));

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

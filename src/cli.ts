#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { BlueBubblesServer } from "./bluebubbles/server.js";
import { BlueBubblesService } from "./bluebubbles/service.js";
import { BlueBubblesStore } from "./bluebubbles/store.js";
import { directChatGuid, toTransportAddress } from "./bluebubbles/guid.js";
import {
  IdsCanaryReceiptMonitor,
  type IdsCanaryReceiptEvidence,
} from "./ids-canary-receipt.js";
import {
  archiveIdsCanaryJournal,
  beginIdsCanaryJournal,
  createIdsCanaryHoldPolicy,
  finishIdsCanaryJournal,
  loadIdsCanaryJournal,
  resolveIdsCanaryOfflineStatus,
  saveIdsCanaryJournal,
} from "./ids-canary-journal.js";
import {
  createIdsCanaryBackoffPolicy,
  createIdsProbeBackoffPolicy,
  createIdsProbePlan,
  executeIdsCanary,
  executeIdsProbe,
} from "./ids-probe.js";
import {
  NativeEngine,
  type ICloudKeychainDevice,
  type ICloudWebPhoneOption,
  type LoginStartResult,
  type TwoFactorPhoneOption,
} from "./native/engine.js";
import { NativeRpcError } from "./native/rpc-client.js";
import {
  assertOutboundVerificationAllowed,
  runOutboundVerification,
} from "./outbound-verification.js";
import {
  deleteIdsPolicy,
  idsPolicyActive,
  loadIdsPolicy,
  prepareProfile,
  profilePaths,
  saveIdsPolicy,
  SessionStore,
} from "./profile.js";
import type { InitializeParams, PersistedSession } from "./types.js";

const command = process.argv[2] ?? "help";
const args = parseArgs({
  args: process.argv.slice(3),
  allowPositionals: true,
  strict: true,
  options: {
    profile: { type: "string", default: "default" },
    "data-root": { type: "string" },
    native: { type: "string" },
    "apple-id": { type: "string" },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "1234" },
    "server-password": { type: "string" },
    "server-password-file": { type: "string" },
    "hardware-key-file": { type: "string" },
    "nac-binary-file": { type: "string" },
    "credential-key-file": { type: "string" },
    "ids-passive": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    hours: { type: "string", default: "24" },
    "empty-cooldown-hours": { type: "string", default: "72" },
    "receipt-wait-seconds": { type: "string", default: "30" },
    from: { type: "string" },
    transport: { type: "string" },
    message: { type: "string" },
    "local-only": { type: "boolean", default: false },
    confirm: { type: "boolean", default: false },
    "confirm-live": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

async function main(): Promise<void> {
  switch (command) {
    case "login":
      await login();
      break;
    case "serve":
      await serve();
      break;
    case "logout":
      await logout();
      break;
    case "icloud-keychain-setup":
      await iCloudKeychainSetup();
      break;
    case "icloud-web-setup":
      await iCloudWebSetup();
      break;
    case "doctor":
      await doctor();
      break;
    case "registration-inspect":
      await registrationInspect();
      break;
    case "registration-refresh":
      await registrationRefresh();
      break;
    case "ids-probe":
      await idsProbe();
      break;
    case "ids-canary":
      await idsCanary();
      break;
    case "ids-canary-status":
      await idsCanaryStatus();
      break;
    case "outbound-verify":
      await outboundVerify();
      break;
    case "ids-cooldown":
      await idsCooldown();
      break;
    case "migrate-credentials":
      await migrateCredentials();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

async function login(): Promise<void> {
  const profile = args.values.profile!;
  const paths = profilePaths(profile, args.values["data-root"]);
  await prepareProfile(paths);
  const sessions = new SessionStore(profile, paths.session);
  const existing = await sessions.load();
  const credentialKeyFile = credentialKeyPath(paths);
  const engine = new NativeEngine({
    stateDir: paths.native,
    ...(args.values.native ? { binaryPath: args.values.native } : {}),
    ...(credentialKeyFile ? { credentialKeyFile } : {}),
    ...(nacBinaryPath() ? { nacBinaryFile: nacBinaryPath() } : {}),
    requestTimeoutMs: 10 * 60_000,
  });
  engine.on("engine.log", ({ message }: { message: string }) => {
    if (process.env.IBLUE_NATIVE_LOGS === "1") process.stderr.write(`[native] ${message}\n`);
  });

  try {
    const version = await engine.version();
    if (!version.registrationAvailable) {
      throw new Error(
        `this ${version.platform}/${version.architecture} native build can run the iBlue API, ` +
        `but cannot create or refresh an Apple IDS registration (${version.registrationBackend}); ` +
        "on a portable build, provide the extracted hardware key and the supported external NAC binary" +
        (version.registrationDetail ? `: ${version.registrationDetail}` : ""),
      );
    }
    const initialized = await engine.initialize(initializeParams(existing, await hardwareKey()));
    // Persist the APNs token/certificate and synthetic device ID immediately.
    // Registration failures and Ctrl-C must not turn the next login into a new
    // Apple push device. Session files never contain the Apple password or PET.
    await sessions.save(initialized);
    const appleId = args.values["apple-id"] ?? existing?.account?.username ?? (await readLine("Apple Account: "));
    const password = process.env.IBLUE_APPLE_PASSWORD ?? (await readSecret("Apple Account password: "));
    const started = await engine.loginStart(appleId, password);
    if (started.needs2fa) {
      while (true) {
        const code = await readVerificationCode(engine, started);
        const result = await engine.loginSubmit2fa(code);
        if (result.accepted) break;
        process.stderr.write("Apple did not accept that verification code; request or enter a fresh code.\n");
      }
    }
    const snapshot = await finishLoginWithRetry(engine);
    await sessions.save(snapshot);
    process.stdout.write(
      `Profile '${profile}' registered as ${snapshot.handles.join(", ")} without changing Messages.app.\n`,
    );
  } finally {
    await engine.close();
  }
}

async function finishLoginWithRetry(engine: NativeEngine): Promise<Awaited<ReturnType<NativeEngine["loginFinish"]>>> {
  const retryDelaysMs = [5_000, 15_000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await engine.loginFinish();
    } catch (error) {
      const retryDelay = retryDelaysMs[attempt];
      if (!(error instanceof NativeRpcError) || !/\b6004\b/.test(error.message) || retryDelay === undefined) {
        throw error;
      }
      process.stderr.write(
        `Apple returned temporary IDS registration status 6004; retaining this authenticated session and retrying in ${retryDelay / 1_000}s (${attempt + 1}/${retryDelaysMs.length}).\n`,
      );
      await delay(retryDelay);
    }
  }
}

async function readVerificationCode(engine: NativeEngine, started: LoginStartResult): Promise<string> {
  if (started.challenge === "sms") {
    process.stdout.write("Apple sent a verification code to the trusted phone number on this account.\n");
  } else {
    process.stdout.write(
      "Approve the sign-in on a trusted device, or generate a code in Apple Account settings.\n" +
      "If no trusted device is available, type 'sms' to send a code to a trusted phone number.\n",
    );
  }

  while (true) {
    const answer = (await readLine("Apple verification code (or 'sms'): ")).trim();
    if (answer.toLowerCase() === "sms") {
      const { phones } = await engine.login2faOptions();
      if (phones.length === 0) throw new Error("Apple did not return any trusted phone numbers for SMS verification");
      const phone = await chooseTrustedPhone(phones);
      const requested = await engine.loginRequestSms(phone.id);
      if (!requested.sent) throw new Error("Apple did not confirm that the SMS verification code was sent");
      process.stdout.write(`Apple sent a code to the trusted phone number ending in ${phone.lastTwoDigits}.\n`);
      continue;
    }
    const normalized = answer.replaceAll(/\s/g, "");
    if (/^\d{6}$/.test(normalized)) return normalized;
    process.stderr.write("Enter Apple's six-digit code, or type 'sms'.\n");
  }
}

async function chooseTrustedPhone(phones: TwoFactorPhoneOption[]): Promise<TwoFactorPhoneOption> {
  if (phones.length === 1) return phones[0]!;
  process.stdout.write("Trusted phone numbers:\n");
  phones.forEach((phone, index) => {
    process.stdout.write(`  ${index + 1}. ending in ${phone.lastTwoDigits}\n`);
  });
  while (true) {
    const selection = Number.parseInt((await readLine("Send code to number: ")).trim(), 10);
    const selected = phones[selection - 1];
    if (selected) return selected;
    process.stderr.write(`Choose a number from 1 to ${phones.length}.\n`);
  }
}

async function serve(): Promise<void> {
  const profile = args.values.profile!;
  const paths = profilePaths(profile, args.values["data-root"]);
  await prepareProfile(paths);
  const sessions = new SessionStore(profile, paths.session);
  const session = await sessions.load();
  if (!(session?.accountUsername || session?.account) || !session.users || !session.identity) {
    throw new Error(`profile '${profile}' is not logged in; run: npm run dev -- login --profile ${profile}`);
  }
  const serverPassword = args.values["server-password"]
    ?? process.env.IBLUE_SERVER_PASSWORD
    ?? await readOptionalSecretFile(
      args.values["server-password-file"] ?? process.env.IBLUE_SERVER_PASSWORD_FILE,
  );
  if (!serverPassword) {
    throw new Error(
      "set IBLUE_SERVER_PASSWORD, IBLUE_SERVER_PASSWORD_FILE, --server-password, or --server-password-file for BlueBubbles client authentication",
    );
  }

  const credentialKeyFile = credentialKeyPath(paths);
  const idsPolicy = await loadIdsPolicy(paths.idsPolicy);
  // A configured policy remains passive even after its timer elapses. Expiry
  // unlocks a sparse probe; only an explicit disable returns receive handling
  // to automatic peer-key lookups.
  const idsPassive = args.values["ids-passive"] || idsPolicy !== undefined;
  const engine = new NativeEngine({
    stateDir: paths.native,
    ...(args.values.native ? { binaryPath: args.values.native } : {}),
    ...(credentialKeyFile ? { credentialKeyFile } : {}),
    ...(nacBinaryPath() ? { nacBinaryFile: nacBinaryPath() } : {}),
    ...(idsPassive ? { environment: { IBLUE_IDS_PASSIVE: "1" } } : {}),
  });
  const store = new BlueBubblesStore(paths.database, paths.attachments);
  const service = new BlueBubblesService({ profile, password: serverPassword, engine, store, sessionStore: sessions });
  service.on("log", ({ message }: { message: string }) => {
    if (process.env.IBLUE_NATIVE_LOGS === "1") process.stderr.write(`[native] ${message}\n`);
  });
  service.on("error", (error) => process.stderr.write(`${String(error)}\n`));

  await service.start(session, hardwareKeyOverride(await hardwareKey()));
  const api = new BlueBubblesServer({
    service,
    host: args.values.host,
    port: Number(args.values.port),
  });
  const listening = await api.start();
  process.stdout.write(
    `iBlue '${profile}' listening at ${listening.address} ` +
    `(BlueBubbles API v1; ${service.handles.join(", ")}; IDS ${service.snapshot?.idsMode ?? "unknown"}` +
    `${idsPolicy ? (idsPolicyActive(idsPolicy) ? ` until ${idsPolicy.passiveUntil}` : "; cooldown elapsed, probe before disabling") : ""})\n`,
  );

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await api.stop();
    await service.stop();
    store.close();
  };
  process.once("SIGINT", () => void stop().then(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
}

async function logout(): Promise<void> {
  const profile = args.values.profile!;
  const paths = profilePaths(profile, args.values["data-root"]);
  const sessions = new SessionStore(profile, paths.session);
  const session = await sessions.load();
  if (!session) {
    throw new Error(`profile '${profile}' has no saved session`);
  }
  const localOnly = args.values["local-only"]!;
  if (!localOnly && (!session.users || !(session.accountUsername || session.account))) {
    throw new Error(
      `profile '${profile}' has no complete IDS registration to deregister; ` +
      "use --local-only only if you intentionally accept leaving any Apple-side device registration behind",
    );
  }

  await prepareProfile(paths);
  const credentialKeyFile = credentialKeyPath(paths);
  const engine = new NativeEngine({
    stateDir: paths.native,
    ...(args.values.native ? { binaryPath: args.values.native } : {}),
    ...(credentialKeyFile ? { credentialKeyFile } : {}),
    ...(nacBinaryPath() ? { nacBinaryFile: nacBinaryPath() } : {}),
    requestTimeoutMs: 2 * 60_000,
  });
  try {
    // Existing IDS credentials can be deregistered without generating fresh
    // NAC validation data, so do not require the portable signer here. A
    // local-only cleanup needs neither APNs initialization nor a hardware key.
    if (!localOnly) {
      await engine.initialize(initializeParams(session, await hardwareKey()));
    }
    const result = await engine.logout(!localOnly);
    if (!result.credentialDeleted) throw new Error("the native engine did not confirm credential deletion");
    await sessions.delete();
    if (result.deregistered) {
      process.stdout.write(
        `Profile '${profile}' was deregistered from Apple IDS; its credential and local login session were removed. ` +
        "Message history and downloaded attachments were retained.\n",
      );
    } else {
      process.stdout.write(
        `Profile '${profile}' local credentials and login session were removed. ` +
        "The Apple-side IDS registration may remain; remove the device from account.apple.com if needed.\n",
      );
    }
  } finally {
    await engine.close();
  }
}

async function iCloudKeychainSetup(): Promise<void> {
  const profile = args.values.profile!;
  const paths = profilePaths(profile, args.values["data-root"]);
  await prepareProfile(paths);
  const session = await new SessionStore(profile, paths.session).load();
  if (!(session?.accountUsername || session?.account) || !session.users || !session.identity) {
    throw new Error(`profile '${profile}' is not logged in; run: iblue login --profile ${profile}`);
  }

  const credentialKeyFile = credentialKeyPath(paths);
  const engine = new NativeEngine({
    stateDir: paths.native,
    ...(args.values.native ? { binaryPath: args.values.native } : {}),
    ...(credentialKeyFile ? { credentialKeyFile } : {}),
    ...(nacBinaryPath() ? { nacBinaryFile: nacBinaryPath() } : {}),
    requestTimeoutMs: 15 * 60_000,
  });
  try {
    await engine.initialize(initializeParams(session, await hardwareKey()));
    const { devices } = await engine.iCloudKeychainDevices();
    const selected = await chooseEscrowDevice(devices);
    const passcode = await readSecret(`Passcode for ${formatEscrowDevice(selected)}: `);
    if (!passcode) throw new Error("device passcode must not be empty");
    const result = await engine.joinICloudKeychain(passcode, selected.index);
    if (!result.joined) throw new Error("the native engine did not confirm the keychain join");
    process.stdout.write(
      `Profile '${profile}' joined iCloud Keychain using ${formatEscrowDevice(selected)}. ` +
      "The passcode was used only for escrow recovery and was not stored.\n",
    );
  } finally {
    await engine.close();
  }
}

async function iCloudWebSetup(): Promise<void> {
  const profile = args.values.profile!;
  const paths = profilePaths(profile, args.values["data-root"]);
  await prepareProfile(paths);
  const session = await new SessionStore(profile, paths.session).load();
  if (!(session?.accountUsername || session?.account) || !session.users || !session.identity) {
    throw new Error(`profile '${profile}' is not logged in; run: iblue login --profile ${profile}`);
  }

  const credentialKeyFile = credentialKeyPath(paths);
  const engine = new NativeEngine({
    stateDir: paths.native,
    ...(args.values.native ? { binaryPath: args.values.native } : {}),
    ...(credentialKeyFile ? { credentialKeyFile } : {}),
    ...(nacBinaryPath() ? { nacBinaryFile: nacBinaryPath() } : {}),
    requestTimeoutMs: 15 * 60_000,
  });
  try {
    await engine.initialize(initializeParams(session, await hardwareKey()));
    process.stdout.write(
      "Enabling iCloud Photos web access for this profile. This is optional and reuses the " +
      "password hash already stored by iBlue; the Apple Account password is not requested again.\n",
    );
    let status = await engine.iCloudWebLoginStart();
    if (status.needs2fa) {
      let selectedSms: ICloudWebPhoneOption | undefined;
      while (status.needs2fa) {
        process.stdout.write(
          "Approve the iCloud.com sign-in on a trusted device and enter its code. " +
          "Type 'sms' to send a code to a trusted phone number.\n",
        );
        const answer = (await readLine("Apple verification code (or 'sms'): ")).trim();
        if (answer.toLowerCase() === "sms") {
          const { phones } = await engine.iCloudWeb2faOptions();
          if (phones.length === 0) {
            throw new Error("Apple did not return any trusted phone numbers for web-session verification");
          }
          selectedSms = await chooseICloudWebPhone(phones);
          const requested = await engine.iCloudWebRequestSms(selectedSms.id, selectedSms.mode);
          if (!requested.sent) throw new Error("Apple did not confirm that the SMS code was sent");
          process.stdout.write(`Apple sent a code to the trusted number ending in ${selectedSms.lastTwoDigits}.\n`);
          continue;
        }
        const code = answer.replaceAll(/\s/g, "");
        if (!/^\d{6}$/.test(code)) {
          process.stderr.write("Enter Apple's six-digit code, or type 'sms'.\n");
          continue;
        }
        try {
          status = await engine.iCloudWebSubmit2fa(
            code,
            selectedSms?.id,
            selectedSms?.mode,
          );
        } catch (error) {
          process.stderr.write(`${(error as Error).message}; request or enter a fresh code.\n`);
        }
      }
    }
    if (!status.ready || !status.photosAvailable) {
      throw new Error("Apple authenticated the web session but did not expose iCloud Photos");
    }
    if (status.pcsRequired) {
      process.stdout.write(
        "Apple may ask a trusted device to approve access to encrypted Photos data. " +
        "Approve that prompt if it appears; iBlue will wait for it.\n",
      );
    }
    await engine.iCloudWebPreparePhotos();
    process.stdout.write(
      `Profile '${profile}' can now create fresh iCloud Photos share links. ` +
      `${status.reusedSession ? "The existing web session was reused." : "The new web session was stored securely."}\n`,
    );
  } finally {
    await engine.close();
  }
}

async function chooseICloudWebPhone(phones: ICloudWebPhoneOption[]): Promise<ICloudWebPhoneOption> {
  if (phones.length === 1) return phones[0]!;
  process.stdout.write("Trusted phone numbers:\n");
  phones.forEach((phone, index) => {
    process.stdout.write(`  ${index + 1}. ending in ${phone.lastTwoDigits}\n`);
  });
  while (true) {
    const selection = Number.parseInt((await readLine("Send code to number: ")).trim(), 10);
    const selected = phones[selection - 1];
    if (selected) return selected;
    process.stderr.write(`Choose a number from 1 to ${phones.length}.\n`);
  }
}

function formatEscrowDevice(device: ICloudKeychainDevice): string {
  const name = device.name || "Apple device";
  return device.model ? `${name} (${device.model})` : name;
}

async function chooseEscrowDevice(devices: ICloudKeychainDevice[]): Promise<ICloudKeychainDevice> {
  if (devices.length === 0) throw new Error("Apple returned no eligible iCloud Keychain devices");
  if (devices.length === 1) {
    process.stdout.write(`Using ${formatEscrowDevice(devices[0]!)}.\n`);
    return devices[0]!;
  }
  process.stdout.write("Trusted devices with recoverable iCloud Keychain data:\n");
  devices.forEach((device, index) => {
    process.stdout.write(`  ${index + 1}. ${formatEscrowDevice(device)}\n`);
  });
  while (true) {
    const choice = Number.parseInt((await readLine("Device: ")).trim(), 10);
    const selected = devices[choice - 1];
    if (selected) return selected;
    process.stderr.write(`Choose a device from 1 to ${devices.length}.\n`);
  }
}

async function doctor(): Promise<void> {
  const profile = args.values.profile!;
  const paths = profilePaths(profile, args.values["data-root"]);
  const native = args.values.native
    ?? process.env.IBLUE_NATIVE_PATH
    ?? `${process.cwd()}/pkg/rustpushgo/target/release/iblue-native${process.platform === "win32" ? ".exe" : ""}`;
  const checks: Array<[string, boolean, string]> = [];
  const platformSupported = process.platform === "darwin" || process.platform === "linux";
  checks.push([
    "supported platform",
    platformSupported,
    `${process.platform}/${process.arch}${process.platform === "win32" ? " (experimental; not yet validated)" : ""}`,
  ]);
  let nativeExecutable = false;
  try {
    await access(native, constants.X_OK);
    nativeExecutable = true;
    checks.push(["native engine", true, native]);
  } catch {
    checks.push(["native engine", false, `not executable: ${native}; run npm run build:native`]);
  }
  if (nativeExecutable) {
    const credentialKeyFile = credentialKeyPath(paths);
    const engine = new NativeEngine({
      stateDir: paths.native,
      binaryPath: native,
      ...(credentialKeyFile ? { credentialKeyFile } : {}),
      ...(nacBinaryPath() ? { nacBinaryFile: nacBinaryPath() } : {}),
    });
    try {
      const version = await engine.version();
      checks.push([
        "Apple registration backend",
        version.registrationAvailable,
        `${version.registrationBackend} (${version.platform}/${version.architecture})` +
          (version.registrationDetail ? `: ${version.registrationDetail}` : ""),
      ]);
    } catch (error) {
      checks.push(["Apple registration backend", false, String(error)]);
    } finally {
      await engine.close();
    }
  }
  if (process.platform === "darwin") {
    const sip = await execute("/usr/bin/csrutil", ["status"]);
    checks.push(["SIP enabled", /enabled/i.test(sip), sip.trim()]);
  } else {
    const keyPath = hardwareKeyPath();
    checks.push(["hardware key", Boolean(keyPath), keyPath ?? "pass --hardware-key-file"]);
    const nacPath = nacBinaryPath();
    checks.push(["external NAC binary", Boolean(nacPath), nacPath ?? "pass --nac-binary-file"]);
  }
  const session = await new SessionStore(profile, paths.session).load();
  checks.push([
    "profile login",
    Boolean((session?.accountUsername || session?.account) && session.users && session.identity),
    paths.session,
  ]);
  for (const [name, pass, detail] of checks) {
    process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}: ${detail}\n`);
  }
  if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
}

async function registrationInspect(): Promise<void> {
  const profile = args.values.profile!;
  const paths = profilePaths(profile, args.values["data-root"]);
  const session = await new SessionStore(profile, paths.session).load();
  if (!session?.users) {
    throw new Error(`profile '${profile}' has no saved IDS registration`);
  }

  // This process is deliberately not initialized. The native offline-only
  // guard would reject system.initialize even if a future refactor tried it.
  const engine = new NativeEngine({
    stateDir: paths.native,
    ...(args.values.native ? { binaryPath: args.values.native } : {}),
    environment: { IBLUE_OFFLINE_ONLY: "1" },
  });
  try {
    const inspection = await engine.inspectSavedRegistration(session.users);
    if (args.values.json) {
      process.stdout.write(`${JSON.stringify({ profile, inspection }, null, 2)}\n`);
      return;
    }

    process.stdout.write(`Offline IDS registration inspection for profile '${profile}'\n`);
    process.stdout.write(`  saved state SHA-256: ${inspection.savedStateSha256}\n`);
    process.stdout.write(`  IDS users: ${inspection.userCount}\n`);
    process.stdout.write(`  sending handles: ${inspection.sendingHandles.join(", ") || "none"}\n`);
    process.stdout.write(`  complete four-service bundle: ${inspection.completeServiceBundle ? "yes" : "no"}\n`);
    process.stdout.write(`  all local private keys available: ${inspection.allKeyMaterialAvailable ? "yes" : "no"}\n`);
    process.stdout.write(`  locally usable for iMessage: ${inspection.locallyUsableForMadrid ? "yes" : "no"}\n`);
    for (const user of inspection.users) {
      process.stdout.write(
        `  user ${user.userIndex}: ${user.userType}, IDS protocol ${user.protocolVersion}, ` +
        `auth key ${user.authKeyMaterialAvailable ? "available" : "missing"}\n`,
      );
      for (const service of user.services) {
        const registeredAt = service.registeredAtEpochSeconds === null
          ? "unknown"
          : new Date(service.registeredAtEpochSeconds * 1_000).toISOString();
        const renewal = service.secondsUntilReregister === null
          ? "unknown"
          : formatDuration(service.secondsUntilReregister);
        process.stdout.write(
          `    ${service.service}: ${service.renewalState}, renew ${renewal}, registered ${registeredAt}, ` +
          `key ${service.keyMaterialAvailable ? "available" : "missing"}, ` +
          `cert ${service.certificateSha256.slice(0, 16)}…\n`,
        );
      }
    }
    if (inspection.warnings.length > 0) {
      process.stdout.write("  warnings:\n");
      for (const warning of inspection.warnings) process.stdout.write(`    - ${warning}\n`);
    }
    process.stdout.write(
      "No APNs connection, Apple request, NAC generation, or Apple Account credential load was performed.\n",
    );
  } finally {
    await engine.close();
  }
}

async function registrationRefresh(): Promise<void> {
  const profile = args.values.profile!;
  const paths = profilePaths(profile, args.values["data-root"]);
  await prepareProfile(paths);
  const policy = await loadIdsPolicy(paths.idsPolicy);
  if (idsPolicyActive(policy)) {
    throw new Error(
      `IDS cooldown is active until ${policy!.passiveUntil}; ` +
      "registration-refresh cannot bypass the quiet period",
    );
  }
  if (!policy) {
    throw new Error(
      "registration-refresh requires a completed IDS cooldown record; run the canonical canary first",
    );
  }
  const previousCanary = await loadIdsCanaryJournal(paths.idsCanary);
  if (
    previousCanary
    && previousCanary.state !== "lookup-no-send"
    && previousCanary.state !== "in-progress"
  ) {
    throw new Error(
      `registration-refresh is only valid after a canary lookup that sent no message or an interrupted canary with an unknown outcome; ` +
      `current journal state is ${previousCanary.state}. Inspect it with ids-canary-status instead`,
    );
  }
  if (!args.values.confirm) {
    throw new Error(
      "registration-refresh makes one bounded Apple IDS registration operation; rerun with --confirm only " +
      "after a completed cooldown and a failed or interrupted canonical canary",
    );
  }
  const quietHours = Number(args.values["empty-cooldown-hours"]);
  if (!Number.isFinite(quietHours) || quietHours <= 0 || quietHours > 24 * 30) {
    throw new Error("--empty-cooldown-hours must be greater than 0 and no more than 720");
  }

  const sessions = new SessionStore(profile, paths.session);
  const session = await sessions.load();
  if (!(session?.accountUsername || session?.account) || !session.users || !session.identity) {
    throw new Error(`profile '${profile}' is not logged in; run: npm run dev -- login --profile ${profile}`);
  }

  const credentialKeyFile = credentialKeyPath(paths);
  const engine = new NativeEngine({
    stateDir: paths.native,
    ...(args.values.native ? { binaryPath: args.values.native } : {}),
    ...(credentialKeyFile ? { credentialKeyFile } : {}),
    ...(nacBinaryPath() ? { nacBinaryFile: nacBinaryPath() } : {}),
    // A registration refresh is the only intended Apple operation. Incoming
    // traffic must not trigger an unrelated sender-key directory lookup even
    // if a future refactor accidentally tries to start the message client.
    environment: { IBLUE_IDS_PASSIVE: "1" },
    requestTimeoutMs: 10 * 60_000,
  });

  try {
    const initialized = await engine.initialize(initializeParams(session, await hardwareKey()));
    await sessions.save(initialized);
    // Commit the quiet period before the remote registration RPC. A timeout,
    // Apple error, Ctrl-C, or local persistence failure after the request must
    // not leave the command immediately retryable.
    const enabledAt = new Date();
    const quietPolicy = {
      version: 1 as const,
      enabledAt: enabledAt.toISOString(),
      passiveUntil: new Date(enabledAt.getTime() + quietHours * 60 * 60 * 1_000).toISOString(),
      reason: "manual saved-identity IDS registration refresh attempted; quiet period before one canonical canary",
    };
    await saveIdsPolicy(paths.idsPolicy, quietPolicy);
    const refreshed = await engine.refreshRegistration();
    if (
      refreshed.snapshot.deviceId !== initialized.deviceId
      || refreshed.snapshot.identity !== initialized.identity
    ) {
      throw new Error("registration refresh unexpectedly changed the saved iBlue device identity");
    }
    await sessions.save(refreshed.snapshot);
    const archivedCanary = previousCanary
      ? await archiveIdsCanaryJournal(paths.idsCanary, previousCanary)
      : undefined;
    process.stdout.write(
      `Profile '${profile}' refreshed ${refreshed.registeredServices} IDS service registrations ` +
      "using the existing device ID, APNs identity, and NGM keys; no Apple password, 2FA, VM, or " +
      `Messages.app sign-in was used. Passive cooldown is active until ${quietPolicy.passiveUntil}.` +
      `${archivedCanary ? ` Prior canary evidence was archived at ${archivedCanary}.` : ""}\n`,
    );
  } finally {
    await engine.close();
  }
}

async function idsProbe(): Promise<void> {
  const profile = args.values.profile!;
  const paths = profilePaths(profile, args.values["data-root"]);
  const plan = createIdsProbePlan(args.positionals, args.values.transport, args.values.from);
  const idsPolicy = await loadIdsPolicy(paths.idsPolicy);
  if (idsPolicyActive(idsPolicy) && !args.values.force) {
    throw new Error(
      `IDS cooldown is active until ${idsPolicy!.passiveUntil}; ` +
      "wait for it to expire or pass --force only for an intentional sparse probe",
    );
  }
  const sessions = new SessionStore(profile, paths.session);
  const session = await sessions.load();
  if (!(session?.accountUsername || session?.account) || !session.users || !session.identity) {
    throw new Error(`profile '${profile}' is not logged in; run: npm run dev -- login --profile ${profile}`);
  }

  const credentialKeyFile = credentialKeyPath(paths);
  const engine = new NativeEngine({
    stateDir: paths.native,
    ...(args.values.native ? { binaryPath: args.values.native } : {}),
    ...(credentialKeyFile ? { credentialKeyFile } : {}),
    ...(nacBinaryPath() ? { nacBinaryFile: nacBinaryPath() } : {}),
    requestTimeoutMs: 2 * 60_000,
  });

  try {
    const initialized = await engine.initialize(initializeParams(session, await hardwareKey()));
    await sessions.save(initialized);
    const started = await engine.startClient();
    await sessions.save(started);
    const result = await executeIdsProbe(engine, plan);
    process.stdout.write(
      `IDS sparse lookup profile '${profile}' from ${plan.from ?? started.handles[0] ?? "unknown"}\n`,
    );
    process.stdout.write("ADDRESS\tTRANSPORT\tRESULT\n");
    process.stdout.write(
      `${result.target}\t${result.transport === "apns" ? "APNS_TUNNEL" : "DIRECT_HTTPS"}` +
      `\t${result.available ? "available" : "empty"}\n`,
    );
    if (!result.available) {
      const policy = createIdsProbeBackoffPolicy(
        result,
        Number(args.values["empty-cooldown-hours"]),
      );
      await saveIdsPolicy(paths.idsPolicy, policy);
      process.stdout.write(
        `Empty result: passive IDS cooldown extended until ${policy.passiveUntil}. ` +
        "Do not try another target or transport during this interval. " +
        "Restart any running server to ensure it uses passive receive mode.\n",
      );
    }
  } finally {
    await engine.close();
  }
}

async function idsCanary(): Promise<void> {
  const profile = args.values.profile!;
  const paths = profilePaths(profile, args.values["data-root"]);
  const previousCanary = await loadIdsCanaryJournal(paths.idsCanary);
  if (previousCanary) {
    throw new Error(
      `IDS canary ${previousCanary.id} is already journaled with state ${previousCanary.state}; ` +
      `inspect it offline with: npm run dev -- ids-canary-status --profile ${profile}. ` +
      "Do not repeat the canary",
    );
  }
  const policy = await loadIdsPolicy(paths.idsPolicy);
  if (idsPolicyActive(policy)) {
    throw new Error(
      `IDS cooldown is active until ${policy!.passiveUntil}; ` +
      "ids-canary cannot bypass an active cooldown",
    );
  }
  if (args.values.transport && args.values.transport !== "apns") {
    throw new Error("ids-canary only supports the APNs directory transport used by normal sends");
  }
  const message = args.values.message;
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("ids-canary requires an explicit non-empty --message");
  }
  const receiptWaitSeconds = Number(args.values["receipt-wait-seconds"]);
  if (!Number.isFinite(receiptWaitSeconds) || receiptWaitSeconds < 0 || receiptWaitSeconds > 300) {
    throw new Error("--receipt-wait-seconds must be between 0 and 300");
  }
  const quietHours = Number(args.values["empty-cooldown-hours"]);
  // Validate before native startup. The policy is committed immediately before
  // the one Apple lookup so a crash cannot make the canary look repeatable.
  createIdsCanaryHoldPolicy(quietHours);
  const plan = createIdsProbePlan(args.positionals, "apns", args.values.from);
  const sessions = new SessionStore(profile, paths.session);
  const session = await sessions.load();
  if (!(session?.accountUsername || session?.account) || !session.users || !session.identity) {
    throw new Error(`profile '${profile}' is not logged in; run: npm run dev -- login --profile ${profile}`);
  }

  const credentialKeyFile = credentialKeyPath(paths);
  const engine = new NativeEngine({
    stateDir: paths.native,
    ...(args.values.native ? { binaryPath: args.values.native } : {}),
    ...(credentialKeyFile ? { credentialKeyFile } : {}),
    ...(nacBinaryPath() ? { nacBinaryFile: nacBinaryPath() } : {}),
    // Keep inbound pushes from triggering independent sender-key lookups while
    // this process performs the one controlled directory canary.
    environment: { IBLUE_IDS_PASSIVE: "1" },
    requestTimeoutMs: 2 * 60_000,
  });
  // Attach before client.start and message.send. A delivery receipt can arrive
  // before the send RPC response containing the GUID is read by TypeScript.
  const receiptMonitor = new IdsCanaryReceiptMonitor(engine);
  let canaryStore: BlueBubblesStore | undefined;

  try {
    const initialized = await engine.initialize(initializeParams(session, await hardwareKey()));
    await sessions.save(initialized);
    const started = await engine.startClient();
    await sessions.save(started);
    const sender = plan.from ?? started.handles[0];
    if (!sender) throw new Error("the profile has no registered iMessage sending handle");
    const journal = beginIdsCanaryJournal({
      profile,
      target: plan.target,
      sender,
      message,
    });
    const holdPolicy = createIdsCanaryHoldPolicy(quietHours, new Date(journal.startedAt));
    await saveIdsPolicy(paths.idsPolicy, holdPolicy);
    await saveIdsCanaryJournal(paths.idsCanary, journal);
    const result = await executeIdsCanary(engine, {
      target: plan.target,
      sender,
      message,
    });
    let completedJournal = finishIdsCanaryJournal(journal, result);
    await saveIdsCanaryJournal(paths.idsCanary, completedJournal);
    try {
      await sessions.save(await engine.snapshot());
    } catch (error) {
      process.stderr.write(
        `Warning: could not save the post-canary native snapshot (${errorMessage(error)}). ` +
        "Do not repeat the canary because of this local persistence error.\n",
      );
    }
    process.stdout.write(
      `IDS canary profile '${profile}' used ${result.lookup.attempts} strict APNs preflight invocation ` +
      "with native lookup retries and panic bisection disabled.\n",
    );
    process.stdout.write("ROLE\tADDRESS\tRESULT\n");
    process.stdout.write(
      `RECIPIENT\t${result.target}\t${formatCanaryLookup(result.lookup, result.targetLookup, result.targetAvailable)}\n`,
    );
    process.stdout.write(
      `SENDER\t${result.sender}\t${formatCanaryLookup(result.lookup, result.senderLookup, result.senderAvailable)}\n`,
    );
    if (result.lookup.error !== null) {
      process.stdout.write(`LOOKUP_ERROR\t${result.lookup.error}\n`);
    }
    if (!result.guid) {
      const backoff = createIdsCanaryBackoffPolicy(
        result,
        quietHours,
      );
      await saveIdsPolicy(paths.idsPolicy, backoff);
      process.stdout.write(
        `No message send was attempted. Passive IDS cooldown extended until ${backoff.passiveUntil}; ` +
        "do not try another target or transport during this interval.\n",
      );
      return;
    }
    process.stdout.write(
      `Canary accepted by APNs with GUID ${result.guid}. This is transport acceptance, not delivery proof.\n`,
    );

    try {
      canaryStore = new BlueBubblesStore(paths.database, paths.attachments);
      const chatGuid = directChatGuid(result.target);
      canaryStore.ensureDirectChat(chatGuid, { participants: [result.target] });
      canaryStore.insertOutgoing({
        guid: result.guid,
        chatGuid,
        text: message,
      });
      process.stdout.write(
        `Saved the canary as an outgoing BlueBubbles message in chat ${chatGuid}; ` +
        "late receipts can be correlated after the server restarts.\n",
      );
    } catch (error) {
      process.stderr.write(
        `Warning: APNs accepted GUID ${result.guid}, but its local BlueBubbles record could not be saved ` +
        `(${errorMessage(error)}). Do not repeat the canary.\n`,
      );
    }

    const evidence = await receiptMonitor.waitFor(result.guid, receiptWaitSeconds * 1_000);
    persistCanaryEvidence(canaryStore, result.guid, evidence);
    completedJournal = finishIdsCanaryJournal(completedJournal, result, evidence);
    await saveIdsCanaryJournal(paths.idsCanary, completedJournal);
    printCanaryEvidence(result.guid, evidence, receiptWaitSeconds);
    if (evidence.kind === "delivered" || evidence.kind === "read") {
      process.stdout.write(
        `Delivery is confirmed. Keep the server passive until you run: ` +
        `npm run dev -- ids-cooldown disable --profile ${profile}\n`,
      );
    } else {
      process.stdout.write(
        "Keep passive mode configured and confirm on the recipient. Do not repeat this canary.\n",
      );
    }
  } finally {
    receiptMonitor.close();
    try {
      canaryStore?.close();
    } finally {
      await engine.close();
    }
  }
}

async function idsCanaryStatus(): Promise<void> {
  const profile = args.values.profile!;
  const paths = profilePaths(profile, args.values["data-root"]);
  const journal = await loadIdsCanaryJournal(paths.idsCanary);
  const policy = await loadIdsPolicy(paths.idsPolicy);
  if (!journal) {
    if (args.values.json) {
      process.stdout.write(`${JSON.stringify({
        profile,
        appleNetworkAccessed: false,
        journal: null,
        status: null,
        policy: policy
          ? { ...policy, active: idsPolicyActive(policy) }
          : null,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`No IDS canary journal exists for profile '${profile}'. No Apple request was made.\n`);
      process.stdout.write(
        `  cooldown: ${policy ? `${idsPolicyActive(policy) ? "active" : "expired"} until ${policy.passiveUntil}` : "not configured"}\n`,
      );
    }
    return;
  }

  let storedMessage: ReturnType<BlueBubblesStore["getMessage"]>;
  const guid = journal.result?.guid;
  if (guid && existsSync(paths.database)) {
    const store = new BlueBubblesStore(paths.database, paths.attachments);
    try {
      storedMessage = store.getMessage(guid);
    } finally {
      store.close();
    }
  }
  const status = resolveIdsCanaryOfflineStatus(journal, storedMessage);
  const output = {
    profile,
    appleNetworkAccessed: false as const,
    journal,
    status,
    policy: policy
      ? { ...policy, active: idsPolicyActive(policy) }
      : null,
  };
  if (args.values.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Offline IDS canary status for profile '${profile}'\n`);
  process.stdout.write(`  run: ${journal.id} (${journal.state})\n`);
  process.stdout.write(`  target: ${journal.target}\n`);
  process.stdout.write(`  started: ${journal.startedAt}\n`);
  process.stdout.write(`  outcome: ${status.outcome}${status.guid ? `; GUID ${status.guid}` : ""}\n`);
  if (status.timestampMs !== undefined) {
    process.stdout.write(`  receipt time: ${new Date(status.timestampMs).toISOString()}\n`);
  }
  if (status.errorStatus !== undefined || status.errorMessage) {
    process.stdout.write(
      `  error: ${status.errorStatus ?? "unknown"}${status.errorMessage ? `: ${status.errorMessage}` : ""}\n`,
    );
  }
  process.stdout.write(
    `  cooldown: ${policy ? `${idsPolicyActive(policy) ? "active" : "expired"} until ${policy.passiveUntil}` : "not configured"}\n`,
  );
  if (status.outcome === "delivered" || status.outcome === "read") {
    process.stdout.write(
      `Delivery is confirmed. Disable the cooldown deliberately before outbound-verify.\n`,
    );
  } else if (status.outcome === "not-sent") {
    process.stdout.write("No message was sent. Preserve the cooldown and follow the bounded recovery sequence.\n");
  } else if (status.outcome === "in-progress") {
    process.stdout.write(
      "The interrupted attempt has an unknown outcome. Do not repeat it. If the recipient did not receive the canary, " +
      "wait for the cooldown to expire, then use the confirmed registration-refresh recovery sequence.\n",
    );
  } else {
    process.stdout.write("Do not repeat the canary. APNs acceptance without a receipt requires recipient confirmation.\n");
  }
  process.stdout.write("No APNs connection, native process, credential load, or Apple request was performed.\n");
}

async function outboundVerify(): Promise<void> {
  const profile = args.values.profile!;
  const paths = profilePaths(profile, args.values["data-root"]);
  await prepareProfile(paths);
  const targetArguments = args.positionals;
  if (targetArguments.length !== 1) {
    throw new Error("outbound-verify requires exactly one recipient address");
  }
  const rawTarget = targetArguments[0]!.trim();
  if (!rawTarget || /\s/.test(rawTarget)) {
    throw new Error("outbound-verify recipient must be non-empty and contain no whitespace");
  }
  const target = toTransportAddress(rawTarget);
  const chatGuid = directChatGuid(target);
  const receiptWaitSeconds = Number(args.values["receipt-wait-seconds"]);
  if (!Number.isFinite(receiptWaitSeconds) || receiptWaitSeconds < 0 || receiptWaitSeconds > 300) {
    throw new Error("--receipt-wait-seconds must be between 0 and 300");
  }
  const policy = await loadIdsPolicy(paths.idsPolicy);
  const sessions = new SessionStore(profile, paths.session);
  const session = await sessions.load();
  if (!(session?.accountUsername || session?.account) || !session.users || !session.identity) {
    throw new Error(`profile '${profile}' is not logged in; run: npm run dev -- login --profile ${profile}`);
  }

  await mkdir(paths.verification, { recursive: true, mode: 0o700 });
  const activeReportPath = join(paths.verification, "outbound-active.json");
  if (existsSync(activeReportPath)) {
    throw new Error(
      `an unfinished outbound verification journal exists at ${activeReportPath}; ` +
      "inspect its accepted steps before deciding whether any live operation is safe to repeat",
    );
  }
  const completedReports = (await readdir(paths.verification))
    .filter((name) => /^outbound-(?!active\.json)[a-zA-Z0-9._-]+\.json$/.test(name));
  if (completedReports.length > 0) {
    throw new Error(
      `outbound verification already completed for profile '${profile}' ` +
      `(${completedReports.join(", ")}); inspect or deliberately archive that evidence before any repeat live run`,
    );
  }

  const store = new BlueBubblesStore(paths.database, paths.attachments);
  let referenceIncomingGuid: string;
  try {
    const savedReference = store.lastIncomingMessageGuid(chatGuid);
    referenceIncomingGuid = assertOutboundVerificationAllowed({
      confirmed: args.values["confirm-live"]!,
      ...(policy ? { policy } : {}),
      ...(savedReference ? { referenceIncomingGuid: savedReference } : {}),
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const credentialKeyFile = credentialKeyPath(paths);
  const engine = new NativeEngine({
    stateDir: paths.native,
    ...(args.values.native ? { binaryPath: args.values.native } : {}),
    ...(credentialKeyFile ? { credentialKeyFile } : {}),
    ...(nacBinaryPath() ? { nacBinaryFile: nacBinaryPath() } : {}),
    requestTimeoutMs: 2 * 60_000,
  });
  engine.on("engine.log", ({ message }: { message: string }) => {
    if (process.env.IBLUE_NATIVE_LOGS === "1") process.stderr.write(`[native] ${message}\n`);
  });
  const password = randomBytes(24).toString("base64url");
  const service = new BlueBubblesService({
    profile,
    password,
    engine,
    store,
    sessionStore: sessions,
  });
  service.on("error", (error) => process.stderr.write(`${String(error)}\n`));
  let serviceStarted = false;
  let api: BlueBubblesServer | undefined;

  try {
    await service.start(session, hardwareKeyOverride(await hardwareKey()));
    serviceStarted = true;
    if (service.snapshot?.idsMode !== "normal") {
      throw new Error("outbound-verify requires normal IDS mode after a confirmed canary");
    }
    api = new BlueBubblesServer({ service, host: "127.0.0.1", port: 0 });
    const listening = await api.start();
    await writeFile(
      activeReportPath,
      `${JSON.stringify({ version: 1, profile, target, state: "starting" }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const report = await runOutboundVerification({
      address: listening.address,
      password,
      profile,
      target,
      chatGuid,
      referenceIncomingGuid,
      receiptWaitSeconds,
      onProgress: async (progress) => {
        await writeFile(activeReportPath, `${JSON.stringify(progress, null, 2)}\n`, { mode: 0o600 });
        await chmod(activeReportPath, 0o600);
      },
    });
    const reportPath = join(paths.verification, `outbound-${report.runId}.json`);
    await rename(activeReportPath, reportPath);
    await chmod(reportPath, 0o600);

    if (args.values.json) {
      process.stdout.write(`${JSON.stringify({ reportPath, report }, null, 2)}\n`);
    } else {
      process.stdout.write(`Outbound BlueBubbles verification run ${report.runId}\n`);
      for (const step of report.steps) {
        const receipt = step.receipt ? `; receipt ${step.receipt}` : "";
        const error = step.errorStatus === undefined ? "" : ` (${step.errorStatus})`;
        process.stdout.write(
          `  ${step.feature}: API accepted${step.guid ? `; GUID ${step.guid}` : ""}${receipt}${error}\n`,
        );
      }
      process.stdout.write(
        `Evidence saved to ${reportPath}. Confirm the expected UI observations on the recipient; ` +
        "API/APNs acceptance alone does not prove reaction, reply, typing, or image rendering semantics.\n",
      );
    }
  } finally {
    try {
      await api?.stop();
    } finally {
      try {
        if (serviceStarted) await service.stop();
        else await engine.close();
      } finally {
        store.close();
      }
    }
  }
}

function persistCanaryEvidence(
  store: BlueBubblesStore | undefined,
  guid: string,
  evidence: IdsCanaryReceiptEvidence,
): void {
  if (!store) return;
  if (evidence.kind === "read") {
    store.markMessageRead(guid, evidence.timestampMs);
  } else if (evidence.kind === "delivered") {
    store.markMessageDelivered(guid, evidence.timestampMs);
  } else if (evidence.kind === "error") {
    store.markMessageError(guid, {
      ...(evidence.status === undefined ? {} : { status: evidence.status }),
      ...(evidence.message === undefined ? {} : { message: evidence.message }),
    });
  }
}

function printCanaryEvidence(
  guid: string,
  evidence: IdsCanaryReceiptEvidence,
  waitSeconds: number,
): void {
  if (evidence.kind === "read") {
    process.stdout.write(`Canary read confirmed by an IDS receipt for GUID ${guid}.\n`);
    return;
  }
  if (evidence.kind === "delivered") {
    process.stdout.write(`Canary delivery confirmed by an IDS receipt for GUID ${guid}.\n`);
    return;
  }
  if (evidence.kind === "error") {
    const status = evidence.status === undefined ? "unknown" : String(evidence.status);
    process.stdout.write(
      `Canary send error received from IDS for GUID ${guid} (status ${status}` +
      `${evidence.message ? `: ${evidence.message}` : ""}).\n`,
    );
    return;
  }
  if (waitSeconds === 0) {
    process.stdout.write("Receipt observation was disabled with --receipt-wait-seconds 0.\n");
  } else {
    process.stdout.write(
      `No matching delivery, read, or send-error receipt was observed within ${waitSeconds} seconds. ` +
      "APNs acceptance is not delivery proof.\n",
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatCanaryLookup(
  lookup: import("./types.js").IdsLookupResult,
  target: import("./types.js").IdsLookupTarget | undefined,
  available: boolean,
): string {
  if (lookup.timedOut) return "timeout";
  if (lookup.panicked) return "panic";
  if (lookup.error !== null) return "error";
  if (!target?.responseEntryReturned) return "omitted";
  if (!target.cacheEntryFresh) return "stale";
  if (available) return `available (${target.identityCount} identities)`;
  return "explicit-empty";
}

async function idsCooldown(): Promise<void> {
  const profile = args.values.profile!;
  const paths = profilePaths(profile, args.values["data-root"]);
  await prepareProfile(paths);
  const action = args.positionals[0] ?? "status";
  if (action === "disable") {
    await deleteIdsPolicy(paths.idsPolicy);
    process.stdout.write(
      `IDS cooldown disabled for profile '${profile}'. Restart any running server to return to normal IDS mode.\n`,
    );
    return;
  }
  if (action === "enable") {
    const hours = Number(args.values.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
      throw new Error("--hours must be greater than 0 and no more than 720");
    }
    const enabledAt = new Date();
    const policy = {
      version: 1 as const,
      enabledAt: enabledAt.toISOString(),
      passiveUntil: new Date(enabledAt.getTime() + hours * 60 * 60 * 1000).toISOString(),
      reason: "Apple IDS returned explicit empty identity lists for self and known-good targets",
    };
    await saveIdsPolicy(paths.idsPolicy, policy);
    process.stdout.write(
      `IDS cooldown enabled for profile '${profile}' until ${policy.passiveUntil}. ` +
      "Serve will use passive receive mode and ids-probe will require --force.\n",
    );
    return;
  }
  if (action !== "status") throw new Error("ids-cooldown action must be enable, disable, or status");
  const policy = await loadIdsPolicy(paths.idsPolicy);
  if (!policy) {
    process.stdout.write(`IDS cooldown is not configured for profile '${profile}'.\n`);
    return;
  }
  process.stdout.write(
    `IDS cooldown for profile '${profile}' is ${idsPolicyActive(policy) ? "active" : "expired"}; ` +
    `passive until ${policy.passiveUntil}.\n`,
  );
}

async function migrateCredentials(): Promise<void> {
  const profile = args.values.profile!;
  const paths = profilePaths(profile, args.values["data-root"]);
  await prepareProfile(paths);
  const sessions = new SessionStore(profile, paths.session);
  const session = await sessions.load();
  if (!(session?.accountUsername || session?.account) || !session.users || !session.identity) {
    throw new Error(`profile '${profile}' is not logged in; run: npm run dev -- login --profile ${profile}`);
  }
  if (existsSync(paths.credentialKey) && existsSync(paths.credentialFile)) {
    process.stdout.write(
      `Profile '${profile}' already uses the encrypted-file credential backend; no migration was needed.\n`,
    );
    return;
  }

  if (!existsSync(paths.credentialKey)) {
    await writeFile(paths.credentialKey, randomBytes(32), { flag: "wx", mode: 0o600 });
  }
  await chmod(paths.credentialKey, 0o600);

  // Intentionally omit credentialKeyFile here: this one invocation must read
  // the existing OS credential so the native process can encrypt a copy into
  // the headless backend. The OS copy is retained as a rollback path.
  const engine = new NativeEngine({
    stateDir: paths.native,
    ...(args.values.native ? { binaryPath: args.values.native } : {}),
    ...(nacBinaryPath() ? { nacBinaryFile: nacBinaryPath() } : {}),
    requestTimeoutMs: 10 * 60_000,
  });
  try {
    const initialized = await engine.initialize(initializeParams(session, await hardwareKey()));
    await sessions.save(initialized);
    const result = await engine.migrateCredentialToFile(paths.credentialKey);
    if (!result.migrated || result.credentialBackend !== "encrypted-file") {
      throw new Error("the native engine did not confirm encrypted credential migration");
    }
    await chmod(paths.credentialFile, 0o600);
    process.stdout.write(
      `Profile '${profile}' now uses owner-only encrypted credential files and will no longer prompt ` +
      "for Keychain access on each rebuilt native binary. The original Keychain item was retained for rollback.\n",
    );
  } finally {
    await engine.close();
  }
}

function initializeParams(session: PersistedSession | undefined, key?: string): InitializeParams {
  if (!session) return hardwareKeyOverride(key);
  return {
    ...(session.deviceId ? { deviceId: session.deviceId } : {}),
    ...(session.apsState ? { apsState: session.apsState } : {}),
    ...(session.users ? { users: session.users } : {}),
    ...(session.identity ? { identity: session.identity } : {}),
    ...(session.account ? { account: session.account } : {}),
    ...hardwareKeyOverride(key),
  };
}

function hardwareKeyPath(): string | undefined {
  return args.values["hardware-key-file"] ?? process.env.IBLUE_HARDWARE_KEY_FILE;
}

function nacBinaryPath(): string | undefined {
  return args.values["nac-binary-file"] ?? process.env.IBLUE_NAC_BINARY_FILE;
}

function credentialKeyPath(paths?: ReturnType<typeof profilePaths>): string | undefined {
  const explicit = args.values["credential-key-file"] ?? process.env.IBLUE_CREDENTIAL_KEY_FILE;
  if (explicit) return explicit;
  if (paths && existsSync(paths.credentialKey) && existsSync(paths.credentialFile)) {
    return paths.credentialKey;
  }
  return undefined;
}

async function hardwareKey(): Promise<string | undefined> {
  const path = hardwareKeyPath();
  return path ? (await readFile(path, "utf8")).trim() : undefined;
}

async function readOptionalSecretFile(path?: string): Promise<string | undefined> {
  if (!path) return undefined;
  const value = (await readFile(path, "utf8")).trim();
  return value || undefined;
}

function hardwareKeyOverride(key?: string): Pick<InitializeParams, "hardwareKey"> {
  return key ? { hardwareKey: key } : {};
}

async function readLine(prompt: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await reader.question(prompt);
  } finally {
    reader.close();
  }
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) return readLine(prompt);
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise<string>((resolveSecret, rejectSecret) => {
    let value = "";
    const finish = (error?: Error): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) rejectSecret(error);
      else resolveSecret(value);
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          value += character;
          process.stdout.write("*");
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

function execute(path: string, commandArgs: string[]): Promise<string> {
  return new Promise((resolveOutput) => {
    execFile(path, commandArgs, (error, stdout, stderr) => resolveOutput(error ? stderr || error.message : stdout));
  });
}

function formatDuration(seconds: number): string {
  const direction = seconds < 0 ? "overdue by " : "in ";
  let remaining = Math.abs(Math.trunc(seconds));
  const days = Math.floor(remaining / 86_400);
  remaining %= 86_400;
  const hours = Math.floor(remaining / 3_600);
  remaining %= 3_600;
  const minutes = Math.floor(remaining / 60);
  const parts = [
    ...(days ? [`${days}d`] : []),
    ...(hours ? [`${hours}h`] : []),
    ...((minutes || (!days && !hours)) ? [`${minutes}m`] : []),
  ];
  return `${direction}${parts.join(" ")}`;
}

function printHelp(): void {
  process.stdout.write(`iBlue — isolated direct-IDS iMessage service\n\n`);
  process.stdout.write(`  iblue login  [--profile secondary] [--apple-id name@example.com]\n`);
  process.stdout.write(`  iblue serve  [--profile secondary] [--host 127.0.0.1] [--port 1234] [--ids-passive]\n`);
  process.stdout.write(`  iblue logout [--profile secondary] [--local-only]\n`);
  process.stdout.write(`  iblue icloud-keychain-setup [--profile secondary]\n`);
  process.stdout.write(`  iblue icloud-web-setup [--profile secondary]\n`);
  process.stdout.write(`  iblue doctor [--profile secondary]\n\n`);
  process.stdout.write(`  iblue registration-inspect [--profile secondary] [--json]\n\n`);
  process.stdout.write(
    "  iblue registration-refresh [--profile secondary] --confirm [--empty-cooldown-hours 72]\n\n",
  );
  process.stdout.write(
    "  iblue ids-probe [--profile secondary] [--from handle] [--transport apns|https] " +
    "[--empty-cooldown-hours 72] <target>\n\n",
  );
  process.stdout.write(
    "  iblue ids-canary [--profile secondary] [--from handle] --message text " +
    "[--receipt-wait-seconds 30] [--empty-cooldown-hours 72] <target>\n\n",
  );
  process.stdout.write("  iblue ids-canary-status [--profile secondary] [--json]\n\n");
  process.stdout.write(
    "  iblue outbound-verify [--profile secondary] --confirm-live " +
    "[--receipt-wait-seconds 30] <target>\n\n",
  );
  process.stdout.write(`  iblue ids-cooldown enable|disable|status [--profile secondary] [--hours 24]\n\n`);
  process.stdout.write(`  iblue migrate-credentials [--profile secondary]\n\n`);
  process.stdout.write(`Cross-platform: --hardware-key-file <path> and --nac-binary-file <path>\n`);
  process.stdout.write(`Container secrets: --credential-key-file <path>\n`);
  process.stdout.write(`Server auth secret: --server-password-file <path>\n`);
  process.stdout.write(`Environment: IBLUE_APPLE_PASSWORD (login only), IBLUE_SERVER_PASSWORD, IBLUE_SERVER_PASSWORD_FILE, IBLUE_NATIVE_PATH, IBLUE_HARDWARE_KEY_FILE, IBLUE_NAC_BINARY_FILE, IBLUE_CREDENTIAL_KEY_FILE\n`);
}

void main().catch((error: Error) => {
  process.stderr.write(`iBlue: ${error.message}\n`);
  process.exitCode = 1;
});

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import type { EngineSnapshot, PersistedSession } from "./types.js";

const PROFILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export interface ProfilePaths {
  root: string;
  native: string;
  attachments: string;
  session: string;
  database: string;
  credentialKey: string;
  credentialFile: string;
  idsPolicy: string;
  idsCanary: string;
  verification: string;
}

export interface IdsPolicy {
  version: 1;
  passiveUntil: string;
  enabledAt: string;
  reason: string;
}

export function profilePaths(profile: string, dataRoot?: string): ProfilePaths {
  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error("profile must start with an alphanumeric character and contain only . _ or -");
  }
  const base = resolve(dataRoot ?? defaultDataRoot());
  const root = join(base, "profiles", profile);
  return {
    root,
    native: join(root, "native"),
    attachments: join(root, "attachments"),
    session: join(root, "session.json"),
    database: join(root, "iblue.sqlite"),
    credentialKey: join(root, "credential.key"),
    credentialFile: join(root, "native", "credentials.enc"),
    idsPolicy: join(root, "ids-policy.json"),
    idsCanary: join(root, "ids-canary.json"),
    verification: join(root, "verification"),
  };
}

export async function loadIdsPolicy(path: string): Promise<IdsPolicy | undefined> {
  try {
    const policy = JSON.parse(await readFile(path, "utf8")) as IdsPolicy;
    if (policy.version !== 1 || !policy.passiveUntil || !policy.enabledAt) {
      throw new Error(`unsupported IDS policy file: ${path}`);
    }
    return policy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function idsPolicyActive(policy: IdsPolicy | undefined, now = Date.now()): boolean {
  return policy !== undefined && Date.parse(policy.passiveUntil) > now;
}

export async function saveIdsPolicy(path: string, policy: IdsPolicy): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function deleteIdsPolicy(path: string): Promise<void> {
  await rm(path, { force: true });
}

function defaultDataRoot(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "iBlue");
  }
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "iBlue");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "iblue");
}

export async function prepareProfile(paths: ProfilePaths): Promise<void> {
  await mkdir(paths.native, { recursive: true, mode: 0o700 });
  await mkdir(paths.attachments, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
}

export class SessionStore {
  constructor(
    readonly profile: string,
    readonly path: string,
  ) {}

  async load(): Promise<PersistedSession | undefined> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8")) as PersistedSession;
      if (data.version !== 1 || data.profile !== this.profile) {
        throw new Error(`unsupported or mismatched session file: ${this.path}`);
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(snapshot: EngineSnapshot): Promise<PersistedSession> {
    const session: PersistedSession = {
      version: 1,
      profile: this.profile,
      deviceId: snapshot.deviceId,
      apsState: snapshot.apsState,
      ...(snapshot.users ? { users: snapshot.users } : {}),
      ...(snapshot.identity ? { identity: snapshot.identity } : {}),
      ...(snapshot.accountUsername ? { accountUsername: snapshot.accountUsername } : {}),
      handles: snapshot.handles,
      updatedAt: new Date().toISOString(),
    };
    const temporary = `${this.path}.${process.pid}.tmp`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
    return session;
  }

  async delete(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

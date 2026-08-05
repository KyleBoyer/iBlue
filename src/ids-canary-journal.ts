import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { BlueBubblesMessage } from "./bluebubbles/contracts.js";
import type { IdsCanaryReceiptEvidence } from "./ids-canary-receipt.js";
import type { IdsCanaryResult } from "./ids-probe.js";
import type { IdsPolicy } from "./profile.js";

export type IdsCanaryJournalResult = Omit<IdsCanaryResult, "message">;

export interface IdsCanaryJournal {
  version: 1;
  id: string;
  profile: string;
  state: "in-progress" | "lookup-no-send" | "transport-accepted";
  target: string;
  sender: string;
  messageSha256: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: IdsCanaryJournalResult;
  receipt?: IdsCanaryReceiptEvidence;
}

export interface IdsCanaryOfflineStatus {
  outcome: "in-progress" | "not-sent" | "transport-accepted" | "delivered" | "read" | "error";
  guid?: string;
  timestampMs?: number;
  errorStatus?: number;
  errorMessage?: string;
  source: "journal" | "message-database";
}

export function beginIdsCanaryJournal(input: {
  profile: string;
  target: string;
  sender: string;
  message: string;
  now?: Date;
  id?: string;
}): IdsCanaryJournal {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("cannot start an IDS canary with an invalid date");
  const timestamp = now.toISOString();
  return {
    version: 1,
    id: input.id ?? randomUUID(),
    profile: input.profile,
    state: "in-progress",
    target: input.target,
    sender: input.sender,
    messageSha256: createHash("sha256").update(input.message).digest("hex"),
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

export function finishIdsCanaryJournal(
  journal: IdsCanaryJournal,
  result: IdsCanaryResult,
  receipt?: IdsCanaryReceiptEvidence,
  now = new Date(),
): IdsCanaryJournal {
  if (!Number.isFinite(now.getTime())) throw new Error("cannot finish an IDS canary with an invalid date");
  const timestamp = now.toISOString();
  const { message: _message, ...journalResult } = result;
  return {
    ...journal,
    state: result.guid ? "transport-accepted" : "lookup-no-send",
    updatedAt: timestamp,
    completedAt: timestamp,
    result: journalResult,
    ...(receipt ? { receipt } : {}),
  };
}

export function createIdsCanaryHoldPolicy(hours = 72, now = new Date()): IdsPolicy {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
    throw new Error("--empty-cooldown-hours must be greater than 0 and no more than 720");
  }
  if (!Number.isFinite(now.getTime())) throw new Error("cannot create an IDS canary hold from an invalid date");
  return {
    version: 1,
    enabledAt: now.toISOString(),
    passiveUntil: new Date(now.getTime() + hours * 60 * 60 * 1_000).toISOString(),
    reason: "canonical IDS canary started; hold passive mode until delivery is confirmed or recovery is selected",
  };
}

export async function loadIdsCanaryJournal(path: string): Promise<IdsCanaryJournal | undefined> {
  try {
    const journal = JSON.parse(await readFile(path, "utf8")) as IdsCanaryJournal;
    if (
      journal.version !== 1
      || !journal.id
      || !journal.profile
      || !journal.target
      || !journal.sender
      || !journal.startedAt
      || !["in-progress", "lookup-no-send", "transport-accepted"].includes(journal.state)
    ) {
      throw new Error(`unsupported IDS canary journal: ${path}`);
    }
    return journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveIdsCanaryJournal(path: string, journal: IdsCanaryJournal): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function archiveIdsCanaryJournal(
  path: string,
  journal: IdsCanaryJournal,
): Promise<string> {
  const archivePath = `${path}.${journal.id}.before-refresh.json`;
  await rename(path, archivePath);
  await chmod(archivePath, 0o600);
  return archivePath;
}

export function resolveIdsCanaryOfflineStatus(
  journal: IdsCanaryJournal,
  message?: Pick<BlueBubblesMessage, "guid" | "error" | "dateRead" | "dateDelivered" | "isDelivered">,
): IdsCanaryOfflineStatus {
  const guid = journal.result?.guid;
  if (message && guid && message.guid.toLowerCase() === guid.toLowerCase()) {
    if (message.error > 0) {
      return { outcome: "error", guid, errorStatus: message.error, source: "message-database" };
    }
    if (message.dateRead !== null) {
      return { outcome: "read", guid, timestampMs: message.dateRead, source: "message-database" };
    }
    if (message.dateDelivered !== null || message.isDelivered) {
      return {
        outcome: "delivered",
        guid,
        ...(message.dateDelivered === null ? {} : { timestampMs: message.dateDelivered }),
        source: "message-database",
      };
    }
  }
  const receipt = journal.receipt;
  if (receipt?.kind === "error") {
    return {
      outcome: "error",
      ...(guid ? { guid } : {}),
      timestampMs: receipt.timestampMs,
      ...(receipt.status === undefined ? {} : { errorStatus: receipt.status }),
      ...(receipt.message === undefined ? {} : { errorMessage: receipt.message }),
      source: "journal",
    };
  }
  if (receipt?.kind === "read" || receipt?.kind === "delivered") {
    return {
      outcome: receipt.kind,
      ...(guid ? { guid } : {}),
      timestampMs: receipt.timestampMs,
      source: "journal",
    };
  }
  if (journal.state === "lookup-no-send") {
    return { outcome: "not-sent", source: "journal" };
  }
  if (journal.state === "transport-accepted") {
    return { outcome: "transport-accepted", ...(guid ? { guid } : {}), source: "journal" };
  }
  return { outcome: "in-progress", source: "journal" };
}

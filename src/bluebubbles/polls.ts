import { randomUUID } from "node:crypto";

import type { IncomingAppBalloon } from "../types.js";
import type {
  IBluePoll,
  IBluePollOption,
  IBluePollVote,
  IBluePollVoteUpdate,
} from "./contracts.js";

export const POLLS_BUNDLE_ID =
  "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.messages.Polls";
const POLLS_BUNDLE_SUFFIX = "com.apple.messages.Polls";
const MAX_POLL_PAYLOAD_BYTES = 256 * 1024;

interface ApplePollEnvelope {
  version?: unknown;
  item?: unknown;
}

interface ApplePollDefinition {
  creatorHandle?: unknown;
  title?: unknown;
  orderedPollOptions?: unknown;
}

interface ApplePollOption {
  optionIdentifier?: unknown;
  creatorHandle?: unknown;
  attributedText?: unknown;
  text?: unknown;
  canBeEdited?: unknown;
}

interface ApplePollResponse {
  votes?: unknown;
}

interface ApplePollVote {
  voteOptionIdentifier?: unknown;
  participantHandle?: unknown;
  serverVoteTime?: unknown;
}

interface DecodedPollPayload {
  source?: string;
  version: number;
  item: Record<string, unknown>;
}

export interface EncodedPollVote {
  json: string;
  balloon: IncomingAppBalloon;
  update: IBluePollVoteUpdate;
}

export interface EncodedPollDefinition {
  transportText: string;
  json: string;
  balloon: IncomingAppBalloon;
  poll: IBluePoll;
}

export function encodePollDefinition(
  creatorHandle: string,
  optionTexts: readonly string[],
  title = "",
  sessionId = randomUUID().toUpperCase(),
): EncodedPollDefinition {
  const options = optionTexts.map((text) => ({
    canBeEdited: false,
    optionIdentifier: randomUUID().toUpperCase(),
    creatorHandle,
    attributedText: text,
    text,
  }));
  const item = { creatorHandle, title, orderedPollOptions: options };
  const json = JSON.stringify({ version: 1, item });
  const encoded = Buffer.from(json, "utf8").toString("base64");
  const balloon: IncomingAppBalloon = {
    appName: "Polls",
    bundleId: POLLS_BUNDLE_ID,
    url: `data:,${encoded}?src=p&c=${options.length}`,
    sessionId,
    isLive: true,
  };
  return {
    transportText: `\x00PL\x01${sessionId}\x01${encoded}\x00\ufffc`,
    json,
    balloon,
    poll: {
      version: 1,
      title,
      creatorHandle,
      options: options.map(({ optionIdentifier, text, canBeEdited }) => ({
        identifier: optionIdentifier,
        text,
        creatorHandle,
        canBeEdited,
      })),
      votes: [],
      sessionId,
      bundleId: POLLS_BUNDLE_ID,
    },
  };
}

export function pollFromBalloon(balloon: IncomingAppBalloon | undefined): IBluePoll | undefined {
  if (!isPollBalloon(balloon)) return undefined;
  const decoded = decodePollPayload(balloon.url);
  if (!decoded) return undefined;
  const definition = decoded.item as ApplePollDefinition;
  if (!Array.isArray(definition.orderedPollOptions)) return undefined;

  const options = definition.orderedPollOptions
    .map(pollOption)
    .filter((option): option is IBluePollOption => option !== undefined);
  if (options.length === 0) return undefined;

  return {
    version: decoded.version,
    title: stringValue(definition.title) ?? "",
    ...(stringValue(definition.creatorHandle)
      ? { creatorHandle: stringValue(definition.creatorHandle)! }
      : {}),
    options,
    votes: [],
    ...(balloon.sessionId ? { sessionId: balloon.sessionId } : {}),
    ...(balloon.bundleId ? { bundleId: balloon.bundleId } : {}),
  };
}

export function pollVoteUpdateFromBalloon(
  balloon: IncomingAppBalloon | undefined,
): IBluePollVoteUpdate | undefined {
  if (!isPollBalloon(balloon)) return undefined;
  const decoded = decodePollPayload(balloon.url);
  if (!decoded) return undefined;
  const response = decoded.item as ApplePollResponse;
  if (!Array.isArray(response.votes)) return undefined;
  const votes = response.votes
    .map(pollVote)
    .filter((vote): vote is IBluePollVote => vote !== undefined);
  return {
    version: decoded.version,
    votes,
    ...(balloon.sessionId ? { sessionId: balloon.sessionId } : {}),
    ...(balloon.bundleId ? { bundleId: balloon.bundleId } : {}),
  };
}

export function isPollBalloon(
  balloon: IncomingAppBalloon | undefined,
): balloon is IncomingAppBalloon {
  return Boolean(balloon?.bundleId?.endsWith(POLLS_BUNDLE_SUFFIX));
}

export function encodePollVote(
  sessionId: string,
  participantHandle: string,
  optionIdentifiers: readonly string[],
): EncodedPollVote {
  const votes = [...new Set(optionIdentifiers)].map((optionIdentifier) => ({
    voteOptionIdentifier: optionIdentifier,
    participantHandle,
  }));
  const json = JSON.stringify({ item: { votes }, version: 1 });
  const balloon: IncomingAppBalloon = {
    appName: "Polls",
    bundleId: POLLS_BUNDLE_ID,
    url: `data:,${Buffer.from(json, "utf8").toString("base64")}`,
    sessionId,
    isLive: false,
  };
  return {
    json,
    balloon,
    update: {
      version: 1,
      votes: votes.map(({ voteOptionIdentifier, participantHandle: voter }) => ({
        optionIdentifier: voteOptionIdentifier,
        participantHandle: voter,
      })),
      participantHandle,
      sessionId,
      bundleId: POLLS_BUNDLE_ID,
    },
  };
}

function pollOption(value: unknown): IBluePollOption | undefined {
  if (!value || typeof value !== "object") return undefined;
  const option = value as ApplePollOption;
  const identifier = stringValue(option.optionIdentifier);
  const text = stringValue(option.text) ?? stringValue(option.attributedText);
  if (!identifier || !text) return undefined;
  return {
    identifier,
    text,
    ...(stringValue(option.attributedText) && stringValue(option.attributedText) !== text
      ? { attributedText: stringValue(option.attributedText)! }
      : {}),
    ...(stringValue(option.creatorHandle)
      ? { creatorHandle: stringValue(option.creatorHandle)! }
      : {}),
    ...(typeof option.canBeEdited === "boolean" ? { canBeEdited: option.canBeEdited } : {}),
  };
}

function pollVote(value: unknown): IBluePollVote | undefined {
  if (!value || typeof value !== "object") return undefined;
  const vote = value as ApplePollVote;
  const optionIdentifier = stringValue(vote.voteOptionIdentifier);
  const participantHandle = stringValue(vote.participantHandle);
  if (!optionIdentifier || !participantHandle) return undefined;
  const serverVoteTime = numberValue(vote.serverVoteTime);
  return {
    optionIdentifier,
    participantHandle,
    ...(serverVoteTime === undefined ? {} : { serverVoteTime }),
  };
}

function decodePollPayload(url: string | undefined): DecodedPollPayload | undefined {
  const value = url?.trim();
  if (!value?.startsWith("data:,")) return undefined;
  const separator = value.lastIndexOf("?");
  const encoded = value.slice(6, separator < 0 ? undefined : separator);
  if (!encoded || encoded.length > MAX_POLL_PAYLOAD_BYTES * 2) return undefined;
  try {
    const bytes = Buffer.from(decodeURIComponent(encoded), "base64");
    if (bytes.length === 0 || bytes.length > MAX_POLL_PAYLOAD_BYTES) return undefined;
    const parsed = JSON.parse(bytes.toString("utf8")) as ApplePollEnvelope;
    if (!parsed || typeof parsed !== "object" || !parsed.item || typeof parsed.item !== "object") {
      return undefined;
    }
    const version = numberValue(parsed.version) ?? 1;
    const source = separator < 0
      ? undefined
      : new URLSearchParams(value.slice(separator + 1)).get("src") ?? undefined;
    return { version, item: parsed.item as Record<string, unknown>, ...(source ? { source } : {}) };
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

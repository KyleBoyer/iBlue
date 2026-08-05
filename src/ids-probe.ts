import { toTransportAddress } from "./bluebubbles/guid.js";
import type { IdsPolicy } from "./profile.js";
import type {
  IdsLookupResult,
  IdsLookupTarget,
  SendMessageParams,
  ValidateHandlesParams,
} from "./types.js";

export type IdsProbeTransport = "apns" | "https";

export interface IdsProbePlan {
  target: string;
  transport: IdsProbeTransport;
  from?: string;
}

export interface IdsProbeResult extends IdsProbePlan {
  available: boolean;
}

export interface IdsProbeEngine {
  validateHandles(params: ValidateHandlesParams): Promise<{ available: string[] }>;
  validateHandlesHttp(params: ValidateHandlesParams): Promise<{ available: string[] }>;
}

export interface IdsCanaryEngine {
  lookupHandles(params: ValidateHandlesParams): Promise<IdsLookupResult>;
  sendMessage(params: SendMessageParams): Promise<{ guid: string }>;
}

export interface IdsCanaryPlan {
  target: string;
  sender: string;
  message: string;
}

export interface IdsCanaryResult extends IdsCanaryPlan {
  targetAvailable: boolean;
  senderAvailable: boolean;
  targetLookup?: IdsLookupTarget;
  senderLookup?: IdsLookupTarget;
  lookup: IdsLookupResult;
  guid?: string;
}

/**
 * Construct the deliberately narrow diagnostic used after an IDS cooldown.
 * One invocation represents one target over one selected directory transport;
 * it never adds the profile's own handles or silently compares both paths.
 */
export function createIdsProbePlan(
  targets: readonly string[],
  transportValue?: string,
  fromValue?: string,
): IdsProbePlan {
  if (targets.length !== 1) {
    throw new Error("ids-probe requires exactly one target address");
  }

  const transport = transportValue ?? "apns";
  if (transport !== "apns" && transport !== "https") {
    throw new Error("--transport must be 'apns' or 'https'");
  }

  const target = normalizeIdsAddress(targets[0]!);
  const from = fromValue === undefined ? undefined : normalizeIdsAddress(fromValue);
  return {
    target,
    transport,
    ...(from ? { from } : {}),
  };
}

export async function executeIdsProbe(
  engine: IdsProbeEngine,
  plan: IdsProbePlan,
): Promise<IdsProbeResult> {
  const params: ValidateHandlesParams = {
    addresses: [plan.target],
    ...(plan.from ? { from: plan.from } : {}),
  };
  const response = plan.transport === "apns"
    ? await engine.validateHandles(params)
    : await engine.validateHandlesHttp(params);
  const targetKey = plan.target.toLowerCase();
  return {
    ...plan,
    available: response.available.some((address) => address.toLowerCase() === targetKey),
  };
}

/**
 * Perform the post-cooldown canary without allowing message.send to discover
 * an empty cache by itself. A normal text send targets both the remote party
 * and the sender's own devices. The strict native lookup disables rustpush's
 * internal error retry and bypasses ids_guard's panic bisection. Priming both
 * addresses in that one invocation means the immediately following send is
 * cache-only; if either address was not returned by this response with a live
 * identity, no message send is attempted at all.
 */
export async function executeIdsCanary(
  engine: IdsCanaryEngine,
  plan: IdsCanaryPlan,
): Promise<IdsCanaryResult> {
  const response = await engine.lookupHandles({
    addresses: [...new Set([plan.target, plan.sender])],
    from: plan.sender,
  });
  const available = new Set(response.available.map((address) => address.toLowerCase()));
  const successful = response.error === null && !response.panicked && !response.timedOut;
  const targetLookup = response.targets.find(
    ({ address }) => address.toLowerCase() === plan.target.toLowerCase(),
  );
  const senderLookup = response.targets.find(
    ({ address }) => address.toLowerCase() === plan.sender.toLowerCase(),
  );
  const isAvailable = (address: string, target?: IdsLookupTarget): boolean =>
    successful &&
    available.has(address.toLowerCase()) &&
    target?.responseEntryReturned === true &&
    target.cacheEntryFresh &&
    target.identityCount > 0;
  const targetAvailable = isAvailable(plan.target, targetLookup);
  const senderAvailable = isAvailable(plan.sender, senderLookup);
  if (!targetAvailable || !senderAvailable) {
    return {
      ...plan,
      targetAvailable,
      senderAvailable,
      ...(targetLookup ? { targetLookup } : {}),
      ...(senderLookup ? { senderLookup } : {}),
      lookup: response,
    };
  }
  const sent = await engine.sendMessage({
    conversation: { participants: [plan.target] },
    text: plan.message,
    from: plan.sender,
  });
  return {
    ...plan,
    targetAvailable,
    senderAvailable,
    ...(targetLookup ? { targetLookup } : {}),
    ...(senderLookup ? { senderLookup } : {}),
    lookup: response,
    guid: sent.guid,
  };
}

export function createIdsCanaryBackoffPolicy(
  result: IdsCanaryResult,
  hours = 72,
  now = new Date(),
): IdsPolicy {
  if (result.guid || (result.targetAvailable && result.senderAvailable)) {
    throw new Error("a ready IDS canary does not require a cooldown");
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
    throw new Error("--empty-cooldown-hours must be greater than 0 and no more than 720");
  }
  if (!Number.isFinite(now.getTime())) {
    throw new Error("cannot create an IDS cooldown from an invalid date");
  }
  return {
    version: 1,
    enabledAt: now.toISOString(),
    passiveUntil: new Date(now.getTime() + hours * 60 * 60 * 1_000).toISOString(),
    reason: idsCanaryBackoffReason(result),
  };
}

function idsCanaryBackoffReason(result: IdsCanaryResult): string {
  if (result.lookup.timedOut) {
    return "Apple IDS APNS canary preflight timed out before proving both required identities";
  }
  if (result.lookup.panicked) {
    return "Apple IDS APNS canary preflight panicked before proving both required identities";
  }
  if (result.lookup.error !== null) {
    return "Apple IDS APNS canary preflight failed before proving both required identities";
  }
  if (
    result.targetLookup?.responseEntryReturned !== true ||
    result.senderLookup?.responseEntryReturned !== true
  ) {
    return "Apple IDS APNS canary response omitted at least one required identity entry";
  }
  return "Apple IDS APNS canary returned an explicit empty identity list for at least one required address";
}

/**
 * Turn an explicit empty directory response into a durable passive-mode
 * backoff. This is intentionally coupled to a completed sparse probe: errors
 * do not masquerade as an Apple response, and an available identity never
 * creates a cooldown.
 */
export function createIdsProbeBackoffPolicy(
  result: IdsProbeResult,
  hours = 72,
  now = new Date(),
): IdsPolicy {
  if (result.available) {
    throw new Error("an available IDS probe result does not require a cooldown");
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
    throw new Error("--empty-cooldown-hours must be greater than 0 and no more than 720");
  }
  if (!Number.isFinite(now.getTime())) {
    throw new Error("cannot create an IDS cooldown from an invalid date");
  }

  return {
    version: 1,
    enabledAt: now.toISOString(),
    passiveUntil: new Date(now.getTime() + hours * 60 * 60 * 1_000).toISOString(),
    reason:
      `Apple IDS ${result.transport.toUpperCase()} sparse lookup returned an explicit empty ` +
      "identity list for one target",
  };
}

function normalizeIdsAddress(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new Error("IDS addresses must be non-empty and contain no whitespace");
  }
  const normalized = toTransportAddress(trimmed);
  if (!/^(?:mailto|tel):.+/i.test(normalized)) {
    throw new Error(`unsupported IDS address: ${value}`);
  }
  return normalized;
}

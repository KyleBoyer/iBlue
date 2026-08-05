import assert from "node:assert/strict";
import test from "node:test";

import {
  createIdsCanaryBackoffPolicy,
  createIdsProbeBackoffPolicy,
  createIdsProbePlan,
  executeIdsCanary,
  executeIdsProbe,
  type IdsCanaryEngine,
  type IdsProbeEngine,
} from "../../src/ids-probe.js";
import type {
  IdsLookupResult,
  IdsLookupTarget,
  SendMessageParams,
  ValidateHandlesParams,
} from "../../src/types.js";

class FakeProbeEngine implements IdsProbeEngine {
  readonly apnsCalls: ValidateHandlesParams[] = [];
  readonly httpsCalls: ValidateHandlesParams[] = [];
  apnsAvailable: string[] = [];
  httpsAvailable: string[] = [];

  validateHandles(params: ValidateHandlesParams): Promise<{ available: string[] }> {
    this.apnsCalls.push(params);
    return Promise.resolve({ available: this.apnsAvailable });
  }

  validateHandlesHttp(params: ValidateHandlesParams): Promise<{ available: string[] }> {
    this.httpsCalls.push(params);
    return Promise.resolve({ available: this.httpsAvailable });
  }
}

class FakeCanaryEngine extends FakeProbeEngine implements IdsCanaryEngine {
  readonly sends: SendMessageParams[] = [];
  readonly lookupCalls: ValidateHandlesParams[] = [];
  lookupResult: IdsLookupResult = {
    available: [],
    targets: [],
    error: null,
    panicked: false,
    timedOut: false,
    attempts: 1,
  };

  lookupHandles(params: ValidateHandlesParams): Promise<IdsLookupResult> {
    this.lookupCalls.push(params);
    return Promise.resolve(this.lookupResult);
  }

  sendMessage(params: SendMessageParams): Promise<{ guid: string }> {
    this.sends.push(params);
    return Promise.resolve({ guid: "canary-guid" });
  }
}

function lookupTarget(
  address: string,
  identityCount: number,
  responseEntryReturned = true,
): IdsLookupTarget {
  return {
    address,
    cacheEntryFresh: true,
    responseEntryReturned,
    identityCount,
    correlationIdentifierPresent: false,
  };
}

test("IDS probe plans require one target and default to one APNs lookup", async () => {
  const plan = createIdsProbePlan([" recipient@example.com "], undefined, "sender@example.com");
  assert.deepEqual(plan, {
    target: "mailto:recipient@example.com",
    transport: "apns",
    from: "mailto:sender@example.com",
  });

  const engine = new FakeProbeEngine();
  engine.apnsAvailable = ["MAILTO:RECIPIENT@EXAMPLE.COM"];
  const result = await executeIdsProbe(engine, plan);

  assert.equal(result.available, true);
  assert.deepEqual(engine.apnsCalls, [{
    addresses: ["mailto:recipient@example.com"],
    from: "mailto:sender@example.com",
  }]);
  assert.equal(engine.httpsCalls.length, 0);
});

test("IDS HTTPS probes never also issue an APNs directory lookup", async () => {
  const plan = createIdsProbePlan(["+16515550100"], "https");
  const engine = new FakeProbeEngine();
  const result = await executeIdsProbe(engine, plan);

  assert.deepEqual(result, {
    target: "tel:+16515550100",
    transport: "https",
    available: false,
  });
  assert.equal(engine.apnsCalls.length, 0);
  assert.deepEqual(engine.httpsCalls, [{ addresses: ["tel:+16515550100"] }]);
});

test("IDS canary primes recipient and sender in one lookup before sending from the same cache", async () => {
  const engine = new FakeCanaryEngine();
  engine.lookupResult = {
    available: ["TEL:+16515550100", "MAILTO:SENDER@EXAMPLE.COM"],
    targets: [
      lookupTarget("tel:+16515550100", 2),
      lookupTarget("mailto:sender@example.com", 1),
    ],
    error: null,
    panicked: false,
    timedOut: false,
    attempts: 1,
  };
  const result = await executeIdsCanary(engine, {
    target: "tel:+16515550100",
    sender: "mailto:sender@example.com",
    message: "one controlled canary",
  });

  assert.deepEqual(engine.lookupCalls, [{
    addresses: ["tel:+16515550100", "mailto:sender@example.com"],
    from: "mailto:sender@example.com",
  }]);
  assert.equal(engine.apnsCalls.length, 0);
  assert.equal(engine.httpsCalls.length, 0);
  assert.deepEqual(engine.sends, [{
    conversation: { participants: ["tel:+16515550100"] },
    text: "one controlled canary",
    from: "mailto:sender@example.com",
  }]);
  assert.equal(result.guid, "canary-guid");
  assert.equal(result.targetAvailable, true);
  assert.equal(result.senderAvailable, true);
});

test("IDS canary never invokes message.send when either identity is absent", async () => {
  const engine = new FakeCanaryEngine();
  engine.lookupResult = {
    available: ["mailto:sender@example.com"],
    targets: [
      lookupTarget("tel:+16515550100", 0),
      lookupTarget("mailto:sender@example.com", 1),
    ],
    error: null,
    panicked: false,
    timedOut: false,
    attempts: 1,
  };
  const result = await executeIdsCanary(engine, {
    target: "tel:+16515550100",
    sender: "mailto:sender@example.com",
    message: "must not leave",
  });

  assert.equal(engine.lookupCalls.length, 1);
  assert.equal(engine.sends.length, 0);
  assert.equal(result.targetAvailable, false);
  assert.equal(result.senderAvailable, true);
  assert.deepEqual(
    createIdsCanaryBackoffPolicy(result, 72, new Date("2026-08-04T21:12:27.596Z")),
    {
      version: 1,
      enabledAt: "2026-08-04T21:12:27.596Z",
      passiveUntil: "2026-08-07T21:12:27.596Z",
      reason: "Apple IDS APNS canary returned an explicit empty identity list for at least one required address",
    },
  );
});

test("IDS canary refuses stale positive cache evidence when the strict lookup fails", async () => {
  const engine = new FakeCanaryEngine();
  engine.lookupResult = {
    available: ["tel:+16515550100", "mailto:sender@example.com"],
    targets: [
      lookupTarget("tel:+16515550100", 2, false),
      lookupTarget("mailto:sender@example.com", 1, false),
    ],
    error: "lookup failed",
    panicked: false,
    timedOut: false,
    attempts: 1,
  };

  const result = await executeIdsCanary(engine, {
    target: "tel:+16515550100",
    sender: "mailto:sender@example.com",
    message: "must not leave",
  });

  assert.equal(result.targetAvailable, false);
  assert.equal(result.senderAvailable, false);
  assert.equal(engine.sends.length, 0);
  assert.equal(
    createIdsCanaryBackoffPolicy(result).reason,
    "Apple IDS APNS canary preflight failed before proving both required identities",
  );
});

test("IDS canary distinguishes an omitted response entry from an explicit empty one", async () => {
  const engine = new FakeCanaryEngine();
  engine.lookupResult = {
    available: ["mailto:sender@example.com"],
    targets: [
      lookupTarget("tel:+16515550100", 0, false),
      lookupTarget("mailto:sender@example.com", 1),
    ],
    error: null,
    panicked: false,
    timedOut: false,
    attempts: 1,
  };

  const result = await executeIdsCanary(engine, {
    target: "tel:+16515550100",
    sender: "mailto:sender@example.com",
    message: "must not leave",
  });

  assert.equal(result.targetAvailable, false);
  assert.equal(result.targetLookup?.responseEntryReturned, false);
  assert.equal(engine.sends.length, 0);
  assert.equal(
    createIdsCanaryBackoffPolicy(result).reason,
    "Apple IDS APNS canary response omitted at least one required identity entry",
  );
});

test("an empty sparse probe creates a bounded 72-hour passive cooldown", () => {
  const policy = createIdsProbeBackoffPolicy({
    target: "tel:+16515550100",
    transport: "apns",
    available: false,
  }, undefined, new Date("2026-08-04T21:12:27.596Z"));

  assert.deepEqual(policy, {
    version: 1,
    enabledAt: "2026-08-04T21:12:27.596Z",
    passiveUntil: "2026-08-07T21:12:27.596Z",
    reason: "Apple IDS APNS sparse lookup returned an explicit empty identity list for one target",
  });
  assert.equal(policy.reason.includes("+16515550100"), false);
});

test("probe backoff rejects available results and unsafe durations", () => {
  const empty = {
    target: "mailto:recipient@example.com",
    transport: "https" as const,
    available: false,
  };
  assert.throws(
    () => createIdsProbeBackoffPolicy({ ...empty, available: true }),
    /does not require a cooldown/,
  );
  assert.throws(() => createIdsProbeBackoffPolicy(empty, 0), /greater than 0/);
  assert.throws(() => createIdsProbeBackoffPolicy(empty, 721), /no more than 720/);
  assert.throws(
    () => createIdsProbeBackoffPolicy(empty, 72, new Date(Number.NaN)),
    /invalid date/,
  );
});

test("IDS probe plans reject zero, multiple, malformed, and ambiguous transports", () => {
  assert.throws(() => createIdsProbePlan([]), /exactly one target/);
  assert.throws(() => createIdsProbePlan(["one@example.com", "two@example.com"]), /exactly one target/);
  assert.throws(() => createIdsProbePlan(["   "]), /non-empty/);
  assert.throws(() => createIdsProbePlan(["one @example.com"]), /whitespace/);
  assert.throws(() => createIdsProbePlan(["one@example.com"], "both"), /apns.*https/);
});

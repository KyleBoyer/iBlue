import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { BlueBubblesMessage, BlueBubblesResponse } from "./bluebubbles/contracts.js";
import type { IdsPolicy } from "./profile.js";

export type OutboundVerificationFeature =
  | "typing-start"
  | "typing-stop"
  | "read-receipt"
  | "text"
  | "reply"
  | "reaction"
  | "image";

export type OutboundReceiptOutcome = "read" | "delivered" | "error" | "not-observed";

export interface OutboundVerificationStep {
  feature: OutboundVerificationFeature;
  apiAccepted: boolean;
  guid?: string;
  receipt?: OutboundReceiptOutcome;
  errorStatus?: number;
  expectedRecipientObservation: string;
}

export interface OutboundVerificationReport {
  version: 1;
  state: "in-progress" | "complete";
  runId: string;
  profile: string;
  target: string;
  chatGuid: string;
  referenceIncomingGuid: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  receiptWaitSeconds: number;
  steps: OutboundVerificationStep[];
}

export interface OutboundVerificationOptions {
  address: string;
  password: string;
  profile: string;
  target: string;
  chatGuid: string;
  referenceIncomingGuid: string;
  receiptWaitSeconds?: number;
  typingDurationMs?: number;
  pollIntervalMs?: number;
  runId?: string;
  onProgress?: (report: OutboundVerificationReport) => void | Promise<void>;
}

const VERIFICATION_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export function assertOutboundVerificationAllowed(input: {
  confirmed: boolean;
  policy?: IdsPolicy;
  referenceIncomingGuid?: string;
}): string {
  if (!input.confirmed) {
    throw new Error(
      "outbound-verify sends live iMessages; rerun with --confirm-live only after the canonical canary is confirmed delivered",
    );
  }
  if (input.policy) {
    throw new Error(
      `IDS cooldown remains configured until ${input.policy.passiveUntil}; ` +
      "disable it only after the canonical canary is confirmed delivered before running outbound-verify",
    );
  }
  if (!input.referenceIncomingGuid) {
    throw new Error(
      "outbound-verify requires an existing incoming message from the target for its reply, reaction, and read-receipt checks",
    );
  }
  return input.referenceIncomingGuid;
}

export async function runOutboundVerification(
  options: OutboundVerificationOptions,
): Promise<OutboundVerificationReport> {
  const receiptWaitSeconds = options.receiptWaitSeconds ?? 30;
  if (!Number.isFinite(receiptWaitSeconds) || receiptWaitSeconds < 0 || receiptWaitSeconds > 300) {
    throw new Error("receiptWaitSeconds must be between 0 and 300");
  }
  const runId = options.runId ?? randomUUID().slice(0, 8);
  const startedAt = new Date();
  const steps: OutboundVerificationStep[] = [];
  const chatPath = encodeURIComponent(options.chatGuid);
  const report: OutboundVerificationReport = {
    version: 1,
    state: "in-progress",
    runId,
    profile: options.profile,
    target: options.target,
    chatGuid: options.chatGuid,
    referenceIncomingGuid: options.referenceIncomingGuid,
    startedAt: startedAt.toISOString(),
    updatedAt: startedAt.toISOString(),
    receiptWaitSeconds,
    steps,
  };
  const checkpoint = async (complete = false): Promise<void> => {
    const timestamp = new Date().toISOString();
    report.updatedAt = timestamp;
    if (complete) {
      report.state = "complete";
      report.completedAt = timestamp;
    }
    await options.onProgress?.(report);
  };
  await checkpoint();

  await request<void>(options, `/api/v1/chat/${chatPath}/typing`, { method: "POST" });
  steps.push({
    feature: "typing-start",
    apiAccepted: true,
    expectedRecipientObservation: "typing indicator appears",
  });
  await checkpoint();
  await delay(Math.max(0, options.typingDurationMs ?? 1_500));
  await request<void>(options, `/api/v1/chat/${chatPath}/typing`, { method: "DELETE" });
  steps.push({
    feature: "typing-stop",
    apiAccepted: true,
    expectedRecipientObservation: "typing indicator disappears",
  });
  await checkpoint();

  await request<void>(options, `/api/v1/chat/${chatPath}/read`, jsonRequest({
    messageGuid: options.referenceIncomingGuid,
  }));
  steps.push({
    feature: "read-receipt",
    apiAccepted: true,
    expectedRecipientObservation: `read receipt applies to ${options.referenceIncomingGuid}`,
  });
  await checkpoint();

  const text = await request<BlueBubblesMessage>(options, "/api/v1/message/text", jsonRequest({
    chatGuid: options.chatGuid,
    message: `iBlue outbound verification text [${runId}]`,
    tempGuid: `iblue-verify-text-${runId}`,
    method: "private-api",
  }));
  steps.push(messageStep(
    "text",
    text,
    `plain text containing marker [${runId}]`,
  ));
  await checkpoint();

  const reply = await request<BlueBubblesMessage>(options, "/api/v1/message/text", jsonRequest({
    chatGuid: options.chatGuid,
    message: `iBlue outbound verification reply [${runId}]`,
    tempGuid: `iblue-verify-reply-${runId}`,
    selectedMessageGuid: options.referenceIncomingGuid,
    partIndex: 0,
    method: "private-api",
  }));
  steps.push(messageStep(
    "reply",
    reply,
    `reply [${runId}] is threaded beneath ${options.referenceIncomingGuid}`,
  ));
  await checkpoint();

  const reaction = await request<BlueBubblesMessage>(options, "/api/v1/message/react", jsonRequest({
    chatGuid: options.chatGuid,
    selectedMessageGuid: options.referenceIncomingGuid,
    reaction: "laugh",
    partIndex: 0,
    method: "private-api",
  }));
  steps.push(messageStep(
    "reaction",
    reaction,
    `haha tapback appears on ${options.referenceIncomingGuid}`,
  ));
  await checkpoint();

  const form = new FormData();
  form.set("attachment", new Blob([VERIFICATION_PNG], { type: "image/png" }), `iblue-verification-${runId}.png`);
  form.set("chatGuid", options.chatGuid);
  form.set("tempGuid", `iblue-verify-image-${runId}`);
  form.set("name", `iblue-verification-${runId}.png`);
  form.set("subject", `iBlue outbound verification image [${runId}]`);
  const image = await request<BlueBubblesMessage>(options, "/api/v1/message/attachment", {
    method: "POST",
    body: form,
  });
  steps.push(messageStep(
    "image",
    image,
    `PNG image with caption marker [${runId}]`,
  ));
  await checkpoint();

  const receiptDeadline = Date.now() + receiptWaitSeconds * 1_000;
  await Promise.all(steps.flatMap((step) => step.guid
    ? [observeReceipt(options, step, receiptDeadline)]
    : []));
  await checkpoint(true);
  return report;
}

function messageStep(
  feature: Extract<OutboundVerificationFeature, "text" | "reply" | "reaction" | "image">,
  message: BlueBubblesMessage,
  expectedRecipientObservation: string,
): OutboundVerificationStep {
  return {
    feature,
    apiAccepted: true,
    guid: message.guid,
    expectedRecipientObservation,
  };
}

async function observeReceipt(
  options: OutboundVerificationOptions,
  step: OutboundVerificationStep,
  deadline: number,
): Promise<void> {
  const guid = step.guid!;
  while (true) {
    const message = await request<BlueBubblesMessage>(
      options,
      `/api/v1/message/${encodeURIComponent(guid)}`,
    );
    if (message.error > 0) {
      step.receipt = "error";
      step.errorStatus = message.error;
      return;
    }
    if (message.dateRead !== null) {
      step.receipt = "read";
      return;
    }
    if (message.dateDelivered !== null || message.isDelivered) {
      step.receipt = "delivered";
      return;
    }
    if (Date.now() >= deadline) {
      step.receipt = "not-observed";
      return;
    }
    await delay(Math.max(10, options.pollIntervalMs ?? 250));
  }
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function request<T>(
  options: Pick<OutboundVerificationOptions, "address" | "password">,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = new URL(path, options.address);
  url.searchParams.set("password", options.password);
  const response = await fetch(url, init);
  const body = await response.json() as BlueBubblesResponse<T>;
  if (!response.ok || body.status >= 400) {
    throw new Error(
      `BlueBubbles ${init?.method ?? "GET"} ${path} failed with HTTP ${response.status}: ` +
      `${body.error?.message ?? body.message}`,
    );
  }
  return body.data as T;
}

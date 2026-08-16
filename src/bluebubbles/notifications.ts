import type {
  BlueBubblesNotificationEvent,
  BlueBubblesNotificationRule,
} from "./contracts.js";
import type { BlueBubblesStore } from "./store.js";

export interface NotificationRuleDraft {
  name?: string | null;
  enabled?: boolean;
  events: readonly string[];
  destination: string;
  callers?: readonly string[];
  filters?: Record<string, string[]> | null;
  template?: string | null;
}

export interface NotificationEventContext {
  type: string;
  /** Counterparty handles involved, already normalized. */
  addresses: readonly string[];
  /** Placeholder values available to a rule template. */
  fields: Record<string, string>;
}

export interface NotificationsOptions {
  store: BlueBubblesStore;
  send: (destination: string, message: string) => Promise<unknown>;
  /** Reports delivery failures without letting them reach the event loop. */
  onError?: (error: unknown, rule: BlueBubblesNotificationRule) => void;
}

/**
 * Standing rules that text a chosen handle when iBlue dispatches an event.
 *
 * Deliveries are best effort by design: a notification failing must never
 * interrupt call handling or message receipt, so failures are recorded on the
 * rule and surfaced through the API rather than thrown.
 */
export class BlueBubblesNotifications {
  readonly store: BlueBubblesStore;

  #send: NotificationsOptions["send"];
  #onError: NotificationsOptions["onError"];
  #recent = new Map<string, number>();

  constructor(options: NotificationsOptions) {
    this.store = options.store;
    this.#send = options.send;
    if (options.onError) this.#onError = options.onError;
  }

  list(): BlueBubblesNotificationRule[] {
    return this.store.listNotificationRules();
  }

  get(id: number): BlueBubblesNotificationRule | undefined {
    return this.store.getNotificationRule(id);
  }

  create(draft: NotificationRuleDraft): BlueBubblesNotificationRule {
    return this.store.createNotificationRule(draft);
  }

  update(
    id: number,
    changes: Partial<NotificationRuleDraft>,
  ): BlueBubblesNotificationRule | undefined {
    const defined = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== undefined),
    ) as Partial<NotificationRuleDraft>;
    return this.store.updateNotificationRule(id, defined);
  }

  delete(id: number): BlueBubblesNotificationRule | undefined {
    return this.store.deleteNotificationRule(id);
  }

  /** Rules that should fire for an event, in stable id order. */
  match(context: NotificationEventContext): BlueBubblesNotificationRule[] {
    const addresses = new Set(context.addresses);
    return this.list().filter((rule) => {
      if (!rule.enabled) return false;
      if (!rule.events.includes("*") && !rule.events.includes(context.type as BlueBubblesNotificationEvent)) {
        return false;
      }
      if (!matchesFilters(rule, context.fields)) return false;
      if (rule.callers.length === 0) return true;
      return rule.callers.some((caller) => addresses.has(caller));
    });
  }

  /**
   * Deliver every matching rule. Rules are independent, so one failing
   * destination does not suppress the others.
   */
  async dispatch(context: NotificationEventContext): Promise<void> {
    for (const rule of this.match(context)) {
      const message = renderNotification(rule, context);
      if (!message) continue;
      // Several producers emit the same event name, and some fire on every
      // lifecycle transition, so identical text for one call would arrive
      // repeatedly. Suppress an exact repeat rather than texting it again.
      if (this.#recentlySent(rule.id, message)) continue;
      try {
        await this.#send(rule.destination, message);
        this.store.recordNotificationRuleDelivery(rule.id);
      } catch (error) {
        this.store.recordNotificationRuleDelivery(
          rule.id,
          error instanceof Error ? error.message : String(error),
        );
        this.#onError?.(error, rule);
      }
    }
  }

  #recentlySent(ruleId: number, message: string): boolean {
    const key = `${ruleId}:${message}`;
    const now = Date.now();
    for (const [seen, at] of this.#recent) {
      if (now - at > DUPLICATE_SUPPRESSION_MS) this.#recent.delete(seen);
    }
    if (this.#recent.has(key)) return true;
    this.#recent.set(key, now);
    return false;
  }
}

/** How long an identical message for one rule is treated as a duplicate. */
const DUPLICATE_SUPPRESSION_MS = 5 * 60_000;

function matchesFilters(
  rule: BlueBubblesNotificationRule,
  fields: Record<string, string>,
): boolean {
  if (!rule.filters) return true;
  return Object.entries(rule.filters).every(([field, allowed]) => {
    if (allowed.length === 0) return true;
    const value = fields[field];
    return value !== undefined && allowed.includes(value);
  });
}

/**
 * Fill a rule's template, or build a default sentence for the event.
 *
 * Unknown placeholders resolve to an empty string rather than being left
 * literal, so a typo produces a slightly bare message instead of leaking
 * `{braces}` into someone's text thread.
 */
export function renderNotification(
  rule: BlueBubblesNotificationRule,
  context: NotificationEventContext,
): string | undefined {
  const fields: Record<string, string> = {
    ...context.fields,
    who: describeCounterparty(context.fields),
  };
  if (rule.template) {
    return rule.template.replace(/\{(\w+)\}/g, (_match, key: string) => fields[key] ?? "");
  }
  return defaultNotificationText({ ...context, fields });
}

/**
 * "+15551234567 (Kyle Boyer)" when a contact name is known, otherwise just the
 * handle. Templates should prefer `{who}` over composing `{caller} ({callerName})`
 * themselves, which leaves empty parentheses for an unknown number.
 */
function describeCounterparty(fields: Record<string, string>): string {
  if (!fields.caller) return "";
  return fields.callerName ? `${fields.caller} (${fields.callerName})` : fields.caller;
}

function defaultNotificationText(context: NotificationEventContext): string | undefined {
  const { fields } = context;
  const who = fields.who;
  switch (context.type) {
    case "incoming-facetime": {
      const mode = fields.mode === "audio" ? "Audio" : "Video";
      return `${who || "Unknown caller"} is FaceTime ${mode} calling right now`;
    }
    case "ft-call-status-changed": {
      const outcome = fields.outcome ?? fields.status ?? "updated";
      const duration = fields.duration && fields.duration !== "not answered"
        ? ` after ${fields.duration}`
        : "";
      return `FaceTime call${who ? ` with ${who}` : ""}: ${outcome}${duration}`;
    }
    case "facetime-auto-answer-rule-matched":
      return `Auto-answering ${fields.mode ?? "call"} from ${who || "unknown caller"}`
        + `${fields.name ? ` using "${fields.name}"` : ""}`;
    case "new-message":
      return `${who || "Unknown sender"}: ${fields.text ?? ""}`.trim();
    case "message-send-error":
      return `Message to ${who || "unknown recipient"} failed${fields.text ? `: ${fields.text}` : ""}`;
    default:
      return `iBlue event ${context.type}${who ? ` involving ${who}` : ""}`;
  }
}

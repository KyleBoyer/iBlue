import type {
  BlueBubblesScheduledMessage,
  BlueBubblesScheduledMessagePayload,
  BlueBubblesScheduledMessageSchedule,
} from "./contracts.js";
import type { BlueBubblesStore } from "./store.js";

const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ScheduledMessageDraft {
  payload: BlueBubblesScheduledMessagePayload;
  scheduledFor: string;
  schedule: BlueBubblesScheduledMessageSchedule;
}

export interface BlueBubblesSchedulerOptions {
  store: BlueBubblesStore;
  send: (payload: BlueBubblesScheduledMessagePayload) => Promise<unknown>;
  dispatch: (type: string, data: unknown) => void;
}

/**
 * A profile-local, durable implementation of BlueBubbles scheduled messages.
 * Timers are only an optimization: every wake reloads the SQLite row and
 * validates its due time, so an update/delete cannot fire an obsolete job.
 */
export class BlueBubblesScheduler {
  readonly store: BlueBubblesStore;

  #send: BlueBubblesSchedulerOptions["send"];
  #dispatch: BlueBubblesSchedulerOptions["dispatch"];
  #timers = new Map<number, NodeJS.Timeout>();
  #inFlight = new Set<Promise<void>>();
  #started = false;

  constructor(options: BlueBubblesSchedulerOptions) {
    this.store = options.store;
    this.#send = options.send;
    this.#dispatch = options.dispatch;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    for (const message of this.store.listScheduledMessages()) {
      await this.#restore(message);
    }
  }

  async stop(): Promise<void> {
    this.#started = false;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await Promise.allSettled([...this.#inFlight]);
  }

  list(): BlueBubblesScheduledMessage[] {
    return this.store.listScheduledMessages();
  }

  get(id: number): BlueBubblesScheduledMessage | undefined {
    return this.store.getScheduledMessage(id);
  }

  create(draft: ScheduledMessageDraft): BlueBubblesScheduledMessage {
    const message = this.store.createScheduledMessage(draft);
    this.#dispatch("scheduled-message-created", message);
    this.#arm(message);
    return message;
  }

  update(id: number, draft: ScheduledMessageDraft): BlueBubblesScheduledMessage | undefined {
    this.#clear(id);
    const message = this.store.updateScheduledMessage(id, draft);
    if (!message) return undefined;
    this.#dispatch("scheduled-message-updated", message);
    this.#arm(message);
    return message;
  }

  delete(id: number): BlueBubblesScheduledMessage | undefined {
    this.#clear(id);
    const message = this.store.deleteScheduledMessage(id);
    if (message) this.#dispatch("scheduled-message-deleted", [message]);
    return message;
  }

  async #restore(message: BlueBubblesScheduledMessage): Promise<void> {
    if (message.status === "in-progress") {
      await this.#failOrReschedule(message, "Server was restarted while the scheduled message was in progress.");
      return;
    }
    if (message.status === "complete" || message.status === "error") {
      if (message.schedule.type === "recurring") {
        const restored = this.#reschedule(message);
        this.store.saveScheduledMessage(restored);
        this.#arm(restored);
      }
      return;
    }
    if (Date.parse(message.scheduledFor) <= Date.now()) {
      await this.#failOrReschedule(
        message,
        "Message expired before it could be sent. Or the server was not online at the time.",
      );
      return;
    }
    this.#arm(message);
  }

  #arm(message: BlueBubblesScheduledMessage): void {
    if (!this.#started || message.status !== "pending") return;
    this.#clear(message.id);
    const delay = Math.max(0, Date.parse(message.scheduledFor) - Date.now());
    const timer = setTimeout(() => {
      this.#timers.delete(message.id);
      const task = this.#wake(message.id);
      this.#inFlight.add(task);
      void task.finally(() => this.#inFlight.delete(task));
    }, Math.min(delay, MAX_TIMEOUT_MS));
    timer.unref();
    this.#timers.set(message.id, timer);
  }

  async #wake(id: number): Promise<void> {
    if (!this.#started) return;
    const message = this.store.getScheduledMessage(id);
    if (!message || message.status !== "pending") return;
    if (Date.parse(message.scheduledFor) > Date.now()) {
      this.#arm(message);
      return;
    }

    const active = this.store.saveScheduledMessage({ ...message, status: "in-progress", error: null });
    if (!active) return;
    this.#dispatch("scheduled-message-updated", active);
    try {
      await this.#send(active.payload);
      const sentAt = new Date().toISOString();
      const completed = active.schedule.type === "recurring"
        ? this.#reschedule({ ...active, sentAt, error: null })
        : { ...active, status: "complete" as const, sentAt, error: null };
      const saved = this.store.saveScheduledMessage(completed);
      if (!saved) return;
      this.#dispatch("scheduled-message-sent", saved);
      if (saved.schedule.type === "recurring") this.#arm(saved);
    } catch (error) {
      await this.#failOrReschedule(active, error instanceof Error ? error.message : String(error));
    }
  }

  async #failOrReschedule(message: BlueBubblesScheduledMessage, error: string): Promise<void> {
    const failed = message.schedule.type === "recurring"
      ? this.#reschedule({ ...message, error })
      : { ...message, status: "error" as const, error };
    const saved = this.store.saveScheduledMessage(failed);
    if (!saved) return;
    this.#dispatch("scheduled-message-error", saved);
    if (saved.schedule.type === "recurring") this.#arm(saved);
  }

  #reschedule(message: BlueBubblesScheduledMessage): BlueBubblesScheduledMessage {
    if (message.schedule.type !== "recurring") return message;
    const step = intervalMilliseconds(message.schedule.intervalType, message.schedule.interval);
    let next = Date.parse(message.scheduledFor) + step;
    const now = Date.now();
    while (next <= now) next += step;
    return {
      ...message,
      scheduledFor: new Date(next).toISOString(),
      status: "pending",
    };
  }

  #clear(id: number): void {
    const timer = this.#timers.get(id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(id);
  }
}

function intervalMilliseconds(
  type: Exclude<BlueBubblesScheduledMessageSchedule, { type: "once" }>["intervalType"],
  interval: number,
): number {
  const hours = type === "hourly"
    ? 1
    : type === "daily"
      ? 24
      : type === "weekly"
        ? 24 * 7
        : type === "monthly"
          ? 24 * 30
          : 24 * 365;
  return interval * hours * 60 * 60 * 1000;
}

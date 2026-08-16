import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BlueBubblesNotifications,
  renderNotification,
} from "../../src/bluebubbles/notifications.js";
import { BlueBubblesStore } from "../../src/bluebubbles/store.js";

async function harness(t: { after: (fn: () => void) => void }, options: {
  fail?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "iblue-notifications-test-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  const sent: Array<{ destination: string; message: string }> = [];
  const notifications = new BlueBubblesNotifications({
    store,
    send: async (destination, message) => {
      if (options.fail) throw new Error("iMessage send failed");
      sent.push({ destination, message });
    },
  });
  return { store, notifications, sent };
}

const base = { destination: "tel:+15550001111", events: ["incoming-facetime"] };

test("a rule fires only for the events it subscribed to", async (t) => {
  const { notifications, sent } = await harness(t);
  notifications.create({ ...base });

  await notifications.dispatch({
    type: "incoming-facetime",
    addresses: ["tel:+15552223333"],
    fields: { event: "incoming-facetime", caller: "+15552223333", mode: "video" },
  });
  await notifications.dispatch({
    type: "new-message",
    addresses: ["tel:+15552223333"],
    fields: { event: "new-message", caller: "+15552223333", text: "hi" },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.destination, "tel:+15550001111");
  assert.match(sent[0]!.message, /is FaceTime Video calling right now/);
});

test("the wildcard subscribes to every event", async (t) => {
  const { notifications, sent } = await harness(t);
  notifications.create({ ...base, events: ["*"] });

  for (const type of ["incoming-facetime", "new-message", "ft-call-status-changed"]) {
    await notifications.dispatch({ type, addresses: [], fields: { event: type } });
  }
  assert.equal(sent.length, 3);
});

test("a caller filter restricts which counterparties notify", async (t) => {
  const { notifications, sent } = await harness(t);
  notifications.create({ ...base, callers: ["tel:+15552223333"] });

  await notifications.dispatch({
    type: "incoming-facetime",
    addresses: ["tel:+15559998888"],
    fields: { event: "incoming-facetime" },
  });
  assert.equal(sent.length, 0, "an unlisted caller must not notify");

  await notifications.dispatch({
    type: "incoming-facetime",
    addresses: ["tel:+15552223333"],
    fields: { event: "incoming-facetime" },
  });
  assert.equal(sent.length, 1);
});

test("a disabled rule never fires", async (t) => {
  const { notifications, sent } = await harness(t);
  const rule = notifications.create({ ...base, enabled: false });
  await notifications.dispatch({
    type: "incoming-facetime",
    addresses: [],
    fields: { event: "incoming-facetime" },
  });
  assert.equal(sent.length, 0);

  notifications.update(rule.id, { enabled: true });
  await notifications.dispatch({
    type: "incoming-facetime",
    addresses: [],
    fields: { event: "incoming-facetime" },
  });
  assert.equal(sent.length, 1);
});

test("templates fill placeholders and unknown ones render empty", () => {
  const rule = {
    id: 1,
    name: null,
    enabled: true,
    events: ["incoming-facetime" as const],
    destination: "tel:+15550001111",
    callers: [],
    filters: null,
    template: "{caller} / {mode} / {nope}",
    deliveredCount: 0,
    lastDeliveredAt: null,
    lastError: null,
    created: "",
    updated: "",
  };
  assert.equal(
    renderNotification(rule, {
      type: "incoming-facetime",
      addresses: [],
      fields: { event: "incoming-facetime", caller: "+15552223333", mode: "video" },
    }),
    "+15552223333 / video / ",
    "an unknown placeholder must not leak braces into the text",
  );
});

test("default wording differs per event type", async (t) => {
  const { notifications, sent } = await harness(t);
  notifications.create({ ...base, events: ["*"] });

  await notifications.dispatch({
    type: "ft-call-status-changed",
    addresses: [],
    fields: { event: "ft-call-status-changed", status: "ended" },
  });
  await notifications.dispatch({
    type: "new-message",
    addresses: ["tel:+15552223333"],
    fields: { event: "new-message", caller: "+15552223333", text: "hello" },
  });

  assert.match(sent[0]!.message, /FaceTime call.*ended/);
  assert.match(sent[1]!.message, /\+15552223333: hello/);
});

test("delivery counters advance and failures are recorded without throwing", async (t) => {
  const { notifications } = await harness(t);
  const rule = notifications.create({ ...base });
  await notifications.dispatch({
    type: "incoming-facetime",
    addresses: [],
    fields: { event: "incoming-facetime" },
  });
  assert.equal(notifications.get(rule.id)?.deliveredCount, 1);
  assert.equal(notifications.get(rule.id)?.lastError, null);

  const failing = await harness(t, { fail: true });
  const failingRule = failing.notifications.create({ ...base });
  // A failed notification must not reject; call handling continues regardless.
  await failing.notifications.dispatch({
    type: "incoming-facetime",
    addresses: [],
    fields: { event: "incoming-facetime" },
  });
  const stored = failing.notifications.get(failingRule.id);
  assert.equal(stored?.deliveredCount, 0);
  assert.equal(stored?.lastError, "iMessage send failed");
});

test("one failing destination does not suppress the others", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-notifications-multi-"));
  const store = new BlueBubblesStore(join(root, "test.sqlite"), join(root, "attachments"));
  t.after(() => store.close());
  const delivered: string[] = [];
  const notifications = new BlueBubblesNotifications({
    store,
    send: async (destination) => {
      if (destination === "tel:+15550001111") throw new Error("unreachable");
      delivered.push(destination);
    },
  });
  notifications.create({ ...base, destination: "tel:+15550001111" });
  notifications.create({ ...base, destination: "tel:+15554445555" });

  await notifications.dispatch({
    type: "incoming-facetime",
    addresses: [],
    fields: { event: "incoming-facetime" },
  });
  assert.deepEqual(delivered, ["tel:+15554445555"]);
});

test("rules and counters survive a store reopen", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-notifications-durable-"));
  const databasePath = join(root, "test.sqlite");
  const attachments = join(root, "attachments");

  const first = new BlueBubblesStore(databasePath, attachments);
  const created = first.createNotificationRule({
    ...base,
    name: "call alerts",
    callers: ["tel:+15552223333"],
  });
  first.recordNotificationRuleDelivery(created.id);
  first.close();

  const second = new BlueBubblesStore(databasePath, attachments);
  t.after(() => second.close());
  const restored = second.getNotificationRule(created.id);
  assert.equal(restored?.name, "call alerts");
  assert.deepEqual(restored?.events, ["incoming-facetime"]);
  assert.deepEqual(restored?.callers, ["tel:+15552223333"]);
  assert.equal(restored?.deliveredCount, 1);
});

test("{who} degrades to the bare handle when no contact name is known", () => {
  const rule = {
    id: 1,
    name: null,
    enabled: true,
    events: ["incoming-facetime" as const],
    destination: "tel:+15550001111",
    callers: [],
    filters: null,
    template: "{who} is calling",
    deliveredCount: 0,
    lastDeliveredAt: null,
    lastError: null,
    created: "",
    updated: "",
  };
  const named = renderNotification(rule, {
    type: "incoming-facetime",
    addresses: [],
    fields: { event: "incoming-facetime", caller: "+15552223333", callerName: "Kyle Boyer" },
  });
  assert.equal(named, "+15552223333 (Kyle Boyer) is calling");

  const unnamed = renderNotification(rule, {
    type: "incoming-facetime",
    addresses: [],
    fields: { event: "incoming-facetime", caller: "+15552223333" },
  });
  assert.equal(unnamed, "+15552223333 is calling", "an unknown caller must not leave empty parentheses");
});

test("filters narrow a lifecycle subscription to the states worth texting", async (t) => {
  const { notifications, sent } = await harness(t);
  notifications.create({
    ...base,
    events: ["ft-call-status-changed"],
    filters: { status: ["ended", "declined"] },
    template: "call {status}",
  });

  // The media lifecycle fires on every transition; only terminal ones notify.
  for (const status of ["preparing", "ringing", "active", "ending"]) {
    await notifications.dispatch({
      type: "ft-call-status-changed",
      addresses: [],
      fields: { event: "ft-call-status-changed", status },
    });
  }
  assert.equal(sent.length, 0, "intermediate states must stay quiet");

  await notifications.dispatch({
    type: "ft-call-status-changed",
    addresses: [],
    fields: { event: "ft-call-status-changed", status: "ended" },
  });
  assert.deepEqual(sent.map((entry) => entry.message), ["call ended"]);
});

test("an identical repeat for one rule is suppressed", async (t) => {
  const { notifications, sent } = await harness(t);
  notifications.create({ ...base, template: "same text every time" });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await notifications.dispatch({
      type: "incoming-facetime",
      addresses: [],
      fields: { event: "incoming-facetime" },
    });
  }
  assert.equal(sent.length, 1, "five identical events must produce one text");
});

test("a changed message still delivers after a suppressed duplicate", async (t) => {
  const { notifications, sent } = await harness(t);
  notifications.create({ ...base, events: ["*"], template: "status {status}" });

  for (const status of ["ringing", "ringing", "ended"]) {
    await notifications.dispatch({
      type: "ft-call-status-changed",
      addresses: [],
      fields: { event: "ft-call-status-changed", status },
    });
  }
  assert.deepEqual(sent.map((entry) => entry.message), ["status ringing", "status ended"]);
});

test("a finished call reports its outcome and duration", async (t) => {
  const { notifications, sent } = await harness(t);
  notifications.create({
    ...base,
    events: ["ft-call-status-changed"],
    template: "{outcome} / {duration} / {durationSeconds}s",
  });

  await notifications.dispatch({
    type: "ft-call-status-changed",
    addresses: [],
    fields: {
      event: "ft-call-status-changed",
      status: "ended",
      outcome: "caller hung up before the media finished",
      duration: "27 seconds",
      durationSeconds: "27",
    },
  });
  assert.equal(sent[0]?.message, "caller hung up before the media finished / 27 seconds / 27s");
});

test("the default call-ended sentence includes outcome and duration", async (t) => {
  const { notifications, sent } = await harness(t);
  notifications.create({ ...base, events: ["ft-call-status-changed"] });

  await notifications.dispatch({
    type: "ft-call-status-changed",
    addresses: [],
    fields: {
      event: "ft-call-status-changed",
      caller: "+15552223333",
      status: "ended",
      outcome: "media played fully and iBlue ended the call",
      duration: "3m 39s",
    },
  });
  assert.equal(
    sent[0]?.message,
    "FaceTime call with +15552223333: media played fully and iBlue ended the call after 3m 39s",
  );
});

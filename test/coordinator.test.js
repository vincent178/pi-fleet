import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AssignmentCoordinator } from "../src/coordinator.js";
import { Fleet } from "../src/fleet.js";
import { HerdrEventWatcher } from "../src/herdr-events.js";
import { FakeHerdr } from "./fake-herdr.js";

function assignment(id, overrides = {}) {
  return {
    id,
    name: `agent-${id}`,
    team: "team-a",
    role: "worker",
    taskId: `task-${id}`,
    taskCard: `/tasks/${id}.md`,
    prompt: "Work",
    cwd: "/work",
    status: "working",
    herdrState: "working",
    workspaceId: "w1",
    tabId: `t-${id}`,
    paneId: `p-${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    releasedAt: null,
    error: null,
    ...overrides,
  };
}

function changed(id, assignmentId, to, from = "working") {
  return {
    id,
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "assignment.changed",
    assignmentId,
    agent: `agent-${assignmentId}`,
    team: "team-a",
    from,
    to,
  };
}

class FakeWatcher extends EventEmitter {
  constructor() {
    super();
    this.paneIds = [];
    this.startCalls = 0;
    this.stopCalls = 0;
  }

  setPaneIds(ids) {
    this.paneIds = ids;
  }

  start() {
    this.startCalls += 1;
  }

  stop() {
    this.stopCalls += 1;
  }
}

class FakeDirectory extends EventEmitter {
  constructor(onEvent) {
    super();
    this.onEvent = onEvent;
    this.closed = false;
  }

  signal(filename = "events.jsonl") {
    this.onEvent("change", filename);
  }

  close() {
    this.closed = true;
  }
}

async function idle(coordinator) {
  for (let count = 0; count < 20; count += 1) {
    await Promise.resolve();
    if (!coordinator.drainPromise) return;
    await coordinator.drainPromise;
  }
  throw new Error("The coordinator did not become idle.");
}

async function appendEvents(fleet, events) {
  const lines = events.map((event) => JSON.stringify(event)).join("\n");
  await appendFile(fleet.store.eventsPath, `${lines}\n`, "utf8");
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-coordinator-"));
  const herdr = new FakeHerdr();
  const assignments = options.assignments ?? [assignment("a1")];
  for (const item of assignments) {
    if (item.status === "released" || !item.paneId) continue;
    herdr.agents.set(item.name, {
      name: item.name,
      agent: "pi",
      agent_status: options.agentStates?.[item.id] ?? "working",
      pane_id: item.paneId,
      tab_id: item.tabId,
      workspace_id: item.workspaceId,
    });
  }
  const fleet = new Fleet({ cwd: root, root: join(root, "fleet"), herdr });
  await fleet.store.init();
  await fleet.store.update((registry) => {
    const teamNames = new Set(assignments.map((item) => item.team));
    registry.teams = [...teamNames].map((name) => ({
      name,
      workerLimit: 5,
      status: "active",
      workspaceId: null,
      tabId: null,
      summaryPaneId: null,
      ownsTab: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      error: null,
    }));
    registry.assignments = assignments;
  });
  if (options.events) await appendEvents(fleet, options.events);
  const watcher = options.watcher ?? new FakeWatcher();
  const files = [];
  const deliveries = [];
  const warnings = [];
  const coordinator = new AssignmentCoordinator({
    fleet,
    watcher,
    deliver: async (message, deliveryOptions) => {
      if (options.deliver) await options.deliver(message, deliveryOptions);
      deliveries.push({ message, options: deliveryOptions });
    },
    onWarning: (error) => warnings.push(error),
    watchDirectory: (_path, onEvent) => {
      const file = new FakeDirectory(onEvent);
      files.push(file);
      return file;
    },
  });
  t.after(async () => {
    await coordinator.stop();
    await rm(root, { recursive: true, force: true });
  });
  await coordinator.start();
  await idle(coordinator);
  return { root, fleet, herdr, watcher, files, deliveries, warnings, coordinator };
}

test("startup ignores historical events and subscribes to every active pane", async (t) => {
  const first = assignment("a1");
  const second = assignment("a2", { role: "verifier", taskCard: "/tasks/shared.md" });
  const released = assignment("a3", { status: "released" });
  const { deliveries, watcher, warnings } = await fixture(t, {
    assignments: [first, second, released],
    events: [changed("old-1", "a1", "blocked")],
  });
  assert.equal(deliveries.length, 0);
  assert.deepEqual(watcher.paneIds, ["p-a1", "p-a2"]);
  assert.deepEqual(warnings, []);
});

test("the initial refresh delivers new actionable transitions", async (t) => {
  const pending = assignment("a1", { status: "dispatched", herdrState: "unknown" });
  const { deliveries } = await fixture(t, {
    assignments: [pending],
    agentStates: { a1: "blocked" },
  });
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].message.content, /State: dispatched -> blocked/);
});

test("multiple assignments deliver independent transitions", async (t) => {
  const first = assignment("a1");
  const second = assignment("a2", { role: "verifier" });
  const { fleet, files, deliveries, coordinator } = await fixture(t, { assignments: [first, second] });
  await appendEvents(fleet, [changed("event-1", "a1", "blocked"), changed("event-2", "a2", "settled")]);
  files[0].signal();
  await idle(coordinator);
  assert.deepEqual(
    deliveries.map(({ message }) => [message.details.assignment.id, message.details.event.to]),
    [
      ["a1", "blocked"],
      ["a2", "settled"],
    ],
  );
});

test("blocked events identify the task, assignment, role, state, and completion rule", async (t) => {
  const { fleet, files, deliveries, coordinator } = await fixture(t);
  await appendEvents(fleet, [changed("event-1", "a1", "blocked")]);
  files[0].signal();
  await idle(coordinator);
  assert.equal(deliveries.length, 1);
  const { message, options } = deliveries[0];
  assert.equal(message.customType, "fleet-assignment");
  assert.equal(message.display, true);
  assert.match(message.content, /Task card: \/tasks\/a1\.md/);
  assert.match(message.content, /Assignment: a1 \(agent-a1\)/);
  assert.match(message.content, /Role: worker/);
  assert.match(message.content, /State: working -> blocked/);
  assert.match(message.content, /Herdr states do not prove task completion/);
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(message.details.eventId, "event-1");
  assert.equal(message.details.assignment.taskCard, "/tasks/a1.md");
});

test("settled, missing, failed, and unknown events notify while working events do not", async (t) => {
  const { fleet, files, deliveries, coordinator } = await fixture(t);
  await appendEvents(fleet, [
    changed("event-working", "a1", "working"),
    changed("event-settled", "a1", "settled"),
    changed("event-missing", "a1", "missing"),
    changed("event-failed", "a1", "failed"),
    changed("event-unknown", "a1", "unknown"),
  ]);
  files[0].signal();
  await idle(coordinator);
  assert.deepEqual(
    deliveries.map(({ message }) => message.details.event.to),
    ["settled", "missing", "failed", "unknown"],
  );
  const delivery = await fleet.store.readDelivery();
  assert.equal(new Set(delivery.handledEventIds).size, delivery.handledEventIds.length);
  assert.ok(delivery.handledEventIds.includes("event-working"));
});

test("lead notifications allow a missing task card", async (t) => {
  const lead = assignment("lead", { role: "lead", taskId: null, taskCard: null });
  const { fleet, files, deliveries, coordinator } = await fixture(t, { assignments: [lead] });
  await appendEvents(fleet, [changed("event-lead", "lead", "settled")]);
  files[0].signal();
  await idle(coordinator);
  assert.match(deliveries[0].message.content, /Task card: none/);
  assert.match(deliveries[0].message.content, /Role: lead/);
});

test("duplicate IDs and ordinary reloads do not resend delivered events", async (t) => {
  const { fleet, files, deliveries, coordinator } = await fixture(t);
  await appendEvents(fleet, [changed("event-1", "a1", "settled"), changed("event-1", "a1", "settled")]);
  files[0].signal();
  files[0].signal();
  await idle(coordinator);
  assert.equal(deliveries.length, 1);
  await coordinator.stop();
  await coordinator.start();
  await coordinator.requestReconciliation();
  assert.equal(deliveries.length, 1);
  assert.equal(files[0].closed, true);
});

test("failed delivery remains pending across an ordinary reload", async (t) => {
  let fail = true;
  const { fleet, files, deliveries, warnings, coordinator } = await fixture(t, {
    deliver: async () => {
      if (fail) {
        fail = false;
        throw new Error("Delivery failed.");
      }
    },
  });
  await appendEvents(fleet, [changed("event-retry", "a1", "blocked")]);
  files[0].signal();
  await idle(coordinator);
  assert.equal(deliveries.length, 0);
  assert.equal(warnings.length, 1);
  assert.ok(!(await fleet.store.readDelivery()).handledEventIds.includes("event-retry"));
  await coordinator.stop();
  await coordinator.start();
  await idle(coordinator);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].message.details.eventId, "event-retry");
});

test("new registry assignments join the watcher without a restart", async (t) => {
  const { fleet, herdr, files, watcher, deliveries, coordinator } = await fixture(t);
  const registry = await fleet.store.read();
  const second = assignment("a2", { taskCard: "/tasks/second.md" });
  registry.assignments.push(second);
  herdr.agents.set(second.name, {
    name: second.name,
    agent: "pi",
    agent_status: "working",
    pane_id: second.paneId,
    tab_id: second.tabId,
    workspace_id: second.workspaceId,
  });
  await fleet.store.update((current) => {
    current.assignments = registry.assignments;
  });
  await appendEvents(fleet, [changed("event-2", "a2", "blocked")]);
  files[0].signal("registry.json");
  await idle(coordinator);
  assert.deepEqual(watcher.paneIds, ["p-a1", "p-a2"]);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].message.content, /second\.md/);
});

test("concurrent registry writes preserve events and join new panes", async (t) => {
  const { fleet, herdr, files, watcher, deliveries, coordinator } = await fixture(t);
  const second = assignment("a2");
  herdr.agents.set(second.name, {
    name: second.name,
    agent: "pi",
    agent_status: "working",
    pane_id: second.paneId,
    tab_id: second.tabId,
    workspace_id: second.workspaceId,
  });
  const status = fleet.status.bind(fleet);
  let inject = true;
  fleet.status = async (...args) => {
    const snapshot = await status(...args);
    if (inject) {
      inject = false;
      await fleet.store.update((registry) => {
        registry.assignments.push(second);
      });
      await appendEvents(fleet, [changed("event-concurrent", "a2", "blocked")]);
    }
    return snapshot;
  };
  files[0].signal();
  await idle(coordinator);
  assert.deepEqual(watcher.paneIds, ["p-a1", "p-a2"]);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].message.details.eventId, "event-concurrent");
});

test("registered discovery events join new panes and unrelated discoveries are ignored", async (t) => {
  const { fleet, herdr, watcher, coordinator } = await fixture(t);
  const registry = await fleet.store.read();
  const second = assignment("a2");
  registry.assignments.push(second);
  herdr.agents.set(second.name, {
    name: second.name,
    agent: "pi",
    agent_status: "working",
    pane_id: second.paneId,
    tab_id: second.tabId,
    workspace_id: second.workspaceId,
  });
  await fleet.store.update((current) => {
    current.assignments = registry.assignments;
  });
  watcher.emit("event", { event: "pane_agent_detected", data: { pane_id: "unknown" } });
  await idle(coordinator);
  assert.deepEqual(watcher.paneIds, ["p-a1"]);
  watcher.emit("event", { event: "pane_agent_detected", data: { pane_id: "p-a2" } });
  await coordinator.requestReconciliation();
  await idle(coordinator);
  assert.deepEqual(watcher.paneIds, ["p-a1", "p-a2"]);
});

test("pane moves reconcile before the next assignment refresh", async (t) => {
  const { fleet, herdr, watcher, coordinator } = await fixture(t);
  Object.assign(herdr.agents.get("agent-a1"), { pane_id: "p-new", tab_id: "t-new", workspace_id: "w2" });
  watcher.emit("event", {
    event: "pane_moved",
    data: {
      previous_pane_id: "p-a1",
      pane: { pane_id: "p-new", tab_id: "t-new", workspace_id: "w2" },
    },
  });
  await coordinator.requestReconciliation();
  const registry = await fleet.store.read();
  assert.equal(registry.assignments[0].paneId, "p-new");
  assert.equal(registry.assignments[0].tabId, "t-new");
  assert.deepEqual(watcher.paneIds, ["p-new"]);
});

test("events received during delivery are preserved and sent in order", async (t) => {
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const { fleet, files, deliveries, coordinator } = await fixture(t, {
    deliver: async (message) => {
      if (message.details.eventId === "event-1") {
        firstStarted();
        await gate;
      }
    },
  });
  await appendEvents(fleet, [changed("event-1", "a1", "blocked")]);
  files[0].signal();
  await started;
  await appendEvents(fleet, [changed("event-2", "a1", "settled", "blocked")]);
  files[0].signal();
  assert.equal(deliveries.length, 0);
  releaseFirst();
  await idle(coordinator);
  assert.deepEqual(
    deliveries.map(({ message }) => message.details.eventId),
    ["event-1", "event-2"],
  );
  const handledEventIds = (await fleet.store.readDelivery()).handledEventIds;
  assert.ok(handledEventIds.includes("event-1"));
  assert.ok(handledEventIds.includes("event-2"));
});

test("stop closes watchers, removes listeners, and ignores later events", async (t) => {
  const { fleet, files, watcher, deliveries, coordinator } = await fixture(t);
  await coordinator.stop();
  assert.ok(watcher.stopCalls >= 1);
  assert.equal(files[0].closed, true);
  assert.equal(watcher.listenerCount("event"), 0);
  assert.equal(watcher.listenerCount("ready"), 0);
  assert.equal(watcher.listenerCount("warning"), 0);
  assert.equal(files[0].listenerCount("error"), 0);
  await appendEvents(fleet, [changed("event-stop", "a1", "blocked")]);
  files[0].signal();
  watcher.emit("event", { event: "pane_agent_status_changed", data: { pane_id: "p-a1" } });
  await idle(coordinator);
  assert.equal(deliveries.length, 0);
});

test("delivery state merges concurrent writes without losing IDs", async (t) => {
  const { fleet, coordinator } = await fixture(t);
  await Promise.all([
    fleet.store.markEventsHandled(["event-1", "shared"]),
    fleet.store.markEventsHandled(["event-2", "shared"]),
    fleet.store.markEventsHandled(["event-3"]),
  ]);
  const delivery = await fleet.store.readDelivery();
  for (const id of ["event-1", "event-2", "event-3", "shared"]) {
    assert.ok(delivery.handledEventIds.includes(id));
  }
  assert.equal(new Set(delivery.handledEventIds).size, delivery.handledEventIds.length);
  assert.equal(await fleet.store.initializeDelivery(), false);
  await coordinator.stop();
});

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  setEncoding() {}

  write(data) {
    this.writes.push(data);
  }

  destroy() {
    this.emit("close");
  }
}

test("socket Herdr events reach the coordinator through the real event parser", async (t) => {
  const sockets = [];
  const watcher = new HerdrEventWatcher({
    socketPath: "/unused",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const { fleet, deliveries, coordinator } = await fixture(t, { watcher });
  const socket = sockets.at(-1);
  socket.emit("connect");
  const subscription = JSON.parse(socket.writes[0]);
  socket.emit(
    "data",
    `${JSON.stringify({ id: subscription.id, result: { type: "subscription_started" } })}\n`,
  );
  await idle(coordinator);
  await appendEvents(fleet, [changed("socket-event", "a1", "blocked")]);
  const herdrEvent = `${JSON.stringify({ id: "event-1", event: { event: "pane_agent_status_changed", data: { pane_id: "p-a1" } } })}\n`;
  socket.emit("data", herdrEvent);
  await idle(coordinator);
  socket.emit("data", herdrEvent);
  await idle(coordinator);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].message.details.eventId, "socket-event");
});

test("socket reconnects recover pending events without duplicate delivery", async (t) => {
  const sockets = [];
  const watcher = new HerdrEventWatcher({
    socketPath: "/unused",
    reconnectMs: 5,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const { fleet, deliveries, coordinator } = await fixture(t, { watcher });
  let socket = sockets.at(-1);
  socket.emit("connect");
  let subscription = JSON.parse(socket.writes[0]);
  socket.emit(
    "data",
    `${JSON.stringify({ id: subscription.id, result: { type: "subscription_started" } })}\n`,
  );
  await idle(coordinator);
  await appendEvents(fleet, [changed("event-before", "a1", "blocked")]);
  socket.emit(
    "data",
    `${JSON.stringify({ id: "herdr-1", event: { event: "pane_agent_status_changed", data: { pane_id: "p-a1" } } })}\n`,
  );
  await idle(coordinator);
  assert.deepEqual(deliveries.map(({ message }) => message.details.eventId), ["event-before"]);
  socket.destroy();
  await appendEvents(fleet, [changed("event-during", "a1", "settled", "blocked")]);
  await delay(20);
  socket = sockets.at(-1);
  assert.equal(sockets.length >= 2, true);
  socket.emit("connect");
  subscription = JSON.parse(socket.writes[0]);
  socket.emit(
    "data",
    `${JSON.stringify({ id: subscription.id, result: { type: "subscription_started" } })}\n`,
  );
  await idle(coordinator);
  assert.deepEqual(
    deliveries.map(({ message }) => message.details.eventId),
    ["event-before", "event-during"],
  );
});

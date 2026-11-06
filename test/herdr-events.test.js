import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { HerdrEventWatcher, isAssignmentEvent, isRegisteredDiscovery } from "../src/herdr-events.js";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  setEncoding() {}

  write(data) {
    this.writes.push(data);
    return true;
  }

  destroy() {
    this.emit("close");
  }

  open() {
    this.emit("connect");
  }
}

function fixture(t, options = {}) {
  const sockets = [];
  const watcher = new HerdrEventWatcher({
    socketPath: "/tmp/herdr-test.sock",
    reconnectMs: 5,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  t.after(() => watcher.stop());
  return { watcher, sockets };
}

function send(socket, value) {
  socket.emit("data", `${JSON.stringify(value)}\n`);
}

test("watcher subscribes and emits Herdr events", (t) => {
  const { watcher, sockets } = fixture(t);
  let ready = 0;
  let event;
  watcher.on("ready", () => {
    ready += 1;
  });
  watcher.on("event", (value) => {
    event = value;
  });
  watcher.setPaneIds(["w1:p1"]);
  watcher.start();
  const socket = sockets[0];
  socket.open();
  const request = JSON.parse(socket.writes[0]);
  assert.equal(request.method, "events.subscribe");
  assert.ok(
    request.params.subscriptions.some(
      (item) => item.type === "pane.agent_status_changed" && item.pane_id === "w1:p1",
    ),
  );
  send(socket, { id: request.id, result: { type: "subscription_started" } });
  assert.equal(ready, 1);
  const value = { event: "tab_closed", data: { type: "tab_closed", tab_id: "w1:t1" } };
  send(socket, value);
  assert.deepEqual(event, value);
});

test("watcher reconnects and resubscribes after disconnect", async (t) => {
  const { watcher, sockets } = fixture(t);
  let ready = 0;
  watcher.on("ready", () => {
    ready += 1;
  });
  watcher.start();
  sockets[0].open();
  sockets[0].emit("close");
  await delay(15);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  const request = JSON.parse(sockets[1].writes[0]);
  send(sockets[1], { id: request.id, result: { type: "subscription_started" } });
  assert.equal(ready, 1);
});

test("pane subscription changes replace the socket subscription", (t) => {
  const { watcher, sockets } = fixture(t);
  watcher.start();
  sockets[0].open();
  watcher.setPaneIds(["w1:p2"]);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  const request = JSON.parse(sockets[1].writes[0]);
  assert.ok(
    request.params.subscriptions.some(
      (item) => item.type === "pane.agent_status_changed" && item.pane_id === "w1:p2",
    ),
  );
});

test("event filter accepts only registered assignment locations", () => {
  const paneIds = new Set(["w1:p1"]);
  const tabIds = new Set(["w1:t1"]);
  assert.equal(isAssignmentEvent({ event: "pane_closed", data: { pane_id: "w1:p1" } }, paneIds, tabIds), true);
  assert.equal(isAssignmentEvent({ event: "pane_closed", data: { pane_id: "w1:p2" } }, paneIds, tabIds), false);
  assert.equal(isAssignmentEvent({ event: "tab_closed", data: { tab_id: "w1:t1" } }, paneIds, tabIds), true);
  assert.equal(isAssignmentEvent({ event: "pane_moved", data: { previous_pane_id: "w1:p1" } }, paneIds, tabIds), true);
  assert.equal(isAssignmentEvent({ event: "pane_agent_detected", data: { pane_id: "w1:p2" } }, paneIds, tabIds), false);
});

test("agent discovery checks the requested team", () => {
  const registry = {
    assignments: [
      { team: "team-a", paneId: "w1:p1", status: "pending" },
      { team: "team-b", paneId: "w1:p2", status: "working" },
      { team: "team-a", paneId: "w1:p3", status: "released" },
    ],
  };
  const event = (paneId) => ({ event: "pane_agent_detected", data: { pane_id: paneId } });
  assert.equal(isRegisteredDiscovery(registry, event("w1:p1"), "team-a"), true);
  assert.equal(isRegisteredDiscovery(registry, event("w1:p2"), "team-a"), false);
  assert.equal(isRegisteredDiscovery(registry, event("w1:p2"), undefined), true);
  assert.equal(isRegisteredDiscovery(registry, event("w1:p3"), "team-a"), false);
});

test("stop prevents reconnection", async (t) => {
  const { watcher, sockets } = fixture(t);
  watcher.start();
  sockets[0].open();
  watcher.stop();
  await delay(15);
  assert.equal(sockets.length, 1);
});

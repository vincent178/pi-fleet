import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { connect } from "node:net";

export function isRegisteredDiscovery(registry, event, team) {
  if (event.event !== "pane_agent_detected") return false;
  const paneId = event.data?.pane_id;
  return registry.assignments.some(
    (assignment) =>
      assignment.paneId === paneId &&
      !["failed", "released"].includes(assignment.status) &&
      (!team || assignment.team === team),
  );
}

export function isAssignmentEvent(event, paneIds, tabIds) {
  const data = event.data ?? {};
  return Boolean(
    (data.pane_id && paneIds.has(data.pane_id)) ||
      (data.previous_pane_id && paneIds.has(data.previous_pane_id)) ||
      (data.tab_id && tabIds.has(data.tab_id)),
  );
}

const DEFAULT_SUBSCRIPTIONS = [
  { type: "tab.closed" },
  { type: "pane.closed" },
  { type: "pane.moved" },
  { type: "pane.exited" },
  { type: "pane.agent_detected" },
];

export class HerdrEventWatcher extends EventEmitter {
  constructor({ socketPath, reconnectMs = 1000, subscriptions = DEFAULT_SUBSCRIPTIONS, socketFactory = connect }) {
    super();
    this.socketPath = socketPath;
    this.reconnectMs = reconnectMs;
    this.baseSubscriptions = subscriptions;
    this.subscriptions = subscriptions;
    this.subscriptionKey = JSON.stringify(subscriptions);
    this.socketFactory = socketFactory;
    this.active = false;
    this.socket = null;
    this.reconnectTimer = null;
    this.generation = 0;
  }

  setPaneIds(paneIds) {
    const uniqueIds = [...new Set(paneIds)].sort();
    const subscriptions = [
      ...this.baseSubscriptions,
      ...uniqueIds.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
    ];
    const key = JSON.stringify(subscriptions);
    if (key === this.subscriptionKey) return;
    this.subscriptionKey = key;
    this.subscriptions = subscriptions;
    if (!this.active) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.open();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.open();
  }

  stop() {
    this.active = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  open() {
    if (!this.active) return;
    const generation = ++this.generation;
    const requestId = `fleet-${randomUUID()}`;
    let buffer = "";
    let socket;
    try {
      socket = this.socketFactory({ path: this.socketPath });
      this.socket = socket;
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        if (!this.isCurrent(socket, generation)) return;
        const request = { id: requestId, method: "events.subscribe", params: { subscriptions: this.subscriptions } };
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk) => {
        if (!this.isCurrent(socket, generation)) return;
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line) this.receive(line, requestId, socket, generation);
          newline = buffer.indexOf("\n");
        }
      });
      socket.on("error", (error) => {
        if (!this.isCurrent(socket, generation)) return;
        this.emit("warning", error);
        socket.destroy();
      });
      socket.on("close", () => {
        if (!this.isCurrent(socket, generation)) return;
        this.socket = null;
        this.scheduleReconnect();
      });
    } catch (error) {
      this.emit("warning", error);
      this.socket = null;
      this.scheduleReconnect();
    }
  }

  receive(line, requestId, socket, generation) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit("warning", error);
      socket.destroy();
      return;
    }
    if (!this.isCurrent(socket, generation)) return;
    if (message.error) {
      this.emit("warning", new Error(message.error.message ?? "Herdr subscription failed"));
      socket.destroy();
      return;
    }
    if (message.id === requestId && message.result?.type === "subscription_started") {
      this.emit("ready");
      return;
    }
    if (message.event) this.emit("event", message);
  }

  isCurrent(socket, generation) {
    return this.active && this.socket === socket && this.generation === generation;
  }

  scheduleReconnect() {
    if (!this.active || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.reconnectMs);
  }
}

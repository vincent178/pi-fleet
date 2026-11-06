import { watch } from "node:fs";
import { isAssignmentEvent, isRegisteredDiscovery } from "./herdr-events.js";
import { registryEventId } from "./store.js";

const ACTIONABLE_STATES = new Set(["blocked", "settled", "missing", "failed", "unknown"]);
const REGISTRY_FILES = new Set(["registry.json", "events.jsonl"]);

export function isActionableAssignmentEvent(event) {
  return event.type === "assignment.changed" && ACTIONABLE_STATES.has(event.to);
}

export function formatAssignmentMessage(event, assignment) {
  return [
    "Fleet assignment changed.",
    `Task card: ${assignment.taskCard ?? "none"}`,
    `Assignment: ${assignment.id} (${assignment.name})`,
    `Role: ${assignment.role}`,
    `State: ${event.from} -> ${event.to}`,
    `Team: ${assignment.team}`,
    "Inspect the assignment before further action.",
    "Herdr states do not prove task completion.",
  ].join("\n");
}

export class AssignmentCoordinator {
  constructor({ fleet, watcher, deliver, onWarning = () => {}, watchDirectory = watch }) {
    this.fleet = fleet;
    this.store = fleet.store;
    this.watcher = watcher;
    this.deliver = deliver;
    this.onWarning = onWarning;
    this.watchDirectory = watchDirectory;
    this.active = false;
    this.pending = false;
    this.pendingMoves = [];
    this.watchedPaneIds = new Set();
    this.watchedTabIds = new Set();
    this.fileWatcher = null;
    this.drainPromise = null;
    this.startPromise = null;
    this.generation = 0;
    this.onReady = () => void this.requestReconciliation();
    this.onEvent = (event) => this.receiveEvent(event);
    this.onWarningEvent = (error) => this.onWarning(error);
    this.onFileEvent = (eventType, filename) => {
      if (filename && !REGISTRY_FILES.has(String(filename))) return;
      void this.requestReconciliation();
    };
  }

  async start() {
    if (this.active) return true;
    if (this.startPromise) return this.startPromise;
    const generation = ++this.generation;
    this.startPromise = this.startSession(generation);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startSession(generation) {
    try {
      await this.store.read();
    } catch (error) {
      if (error.code === "registry_not_found") return false;
      throw error;
    }
    if (generation !== this.generation) return false;
    await this.store.initializeDelivery();
    if (generation !== this.generation) return false;
    this.active = true;
    this.watcher.on("ready", this.onReady);
    this.watcher.on("event", this.onEvent);
    this.watcher.on("warning", this.onWarningEvent);
    try {
      this.fileWatcher = this.watchDirectory(this.fleet.root, this.onFileEvent);
      this.fileWatcher.on("error", this.onWarningEvent);
      this.watcher.start();
      await this.requestReconciliation();
      return true;
    } catch (error) {
      this.closeResources();
      this.active = false;
      throw error;
    }
  }

  receiveEvent(event) {
    if (!this.active) return;
    if (event?.event === "pane_agent_detected" && !this.watchedPaneIds.has(event.data?.pane_id)) {
      void this.store
        .read()
        .then((registry) => {
          if (this.active && isRegisteredDiscovery(registry, event)) return this.requestReconciliation();
        })
        .catch((error) => this.onWarning(error));
      return;
    }
    if (!isAssignmentEvent(event, this.watchedPaneIds, this.watchedTabIds)) return;
    if (event.event === "pane_moved") this.pendingMoves.push(event);
    void this.requestReconciliation();
  }

  requestReconciliation() {
    if (!this.active) return Promise.resolve();
    this.pending = true;
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = null;
        if (this.active && this.pending) void this.requestReconciliation();
      });
    }
    return this.drainPromise;
  }

  async drain() {
    while (this.active && this.pending) {
      this.pending = false;
      try {
        await this.reconcile();
      } catch (error) {
        this.onWarning(error);
      }
    }
  }

  async reconcile() {
    const moves = this.pendingMoves.splice(0);
    for (const event of moves) {
      await this.fleet.reconcileEvent(event);
    }
    await this.fleet.status();
    if (!this.active) return;
    const events = await this.store.readEvents();
    const registry = await this.store.read();
    const delivery = await this.store.readDelivery();
    if (!this.active) return;
    this.watchedPaneIds.clear();
    this.watchedTabIds.clear();
    for (const assignment of registry.assignments) {
      if (["failed", "released"].includes(assignment.status)) continue;
      if (assignment.paneId) this.watchedPaneIds.add(assignment.paneId);
      if (assignment.tabId) this.watchedTabIds.add(assignment.tabId);
    }
    this.watcher.setPaneIds([...this.watchedPaneIds]);
    const handled = new Set(delivery?.handledEventIds ?? []);
    const ignored = [];
    for (const event of events) {
      const id = registryEventId(event);
      if (!handled.has(id) && !isActionableAssignmentEvent(event)) ignored.push(id);
    }
    await this.store.markEventsHandled(ignored);
    for (const id of ignored) handled.add(id);
    for (const event of events) {
      if (!this.active) return;
      const id = registryEventId(event);
      if (handled.has(id) || !isActionableAssignmentEvent(event)) continue;
      const assignment = registry.assignments.find((item) => item.id === event.assignmentId);
      if (!assignment) throw new Error(`Fleet event ${id} has no registry assignment.`);
      await this.deliver(
        {
          customType: "fleet-assignment",
          content: formatAssignmentMessage(event, assignment),
          display: true,
          details: { eventId: id, event, assignment },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      await this.store.markEventsHandled([id]);
      handled.add(id);
    }
  }

  closeResources() {
    this.watcher.removeListener("ready", this.onReady);
    this.watcher.removeListener("event", this.onEvent);
    this.watcher.removeListener("warning", this.onWarningEvent);
    this.watcher.stop();
    if (this.fileWatcher) {
      this.fileWatcher.removeListener("error", this.onWarningEvent);
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
  }

  async stop() {
    this.generation += 1;
    this.active = false;
    this.pending = false;
    this.closeResources();
    if (this.startPromise) await this.startPromise;
    if (this.drainPromise) await this.drainPromise;
  }
}

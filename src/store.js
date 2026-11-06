import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, stat, unlink, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FleetError } from "./errors.js";

const REGISTRY_VERSION = 1;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const DELIVERY_VERSION = 1;
const COORDINATOR_LEASE_VERSION = 1;
const DEFAULT_COORDINATOR_LEASE_MS = 10_000;

export function registryEventId(event) {
  if (event.id) return event.id;
  const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex");
  return `legacy_${digest}`;
}

function newEventId() {
  return `evt_${randomUUID().replaceAll("-", "")}`;
}

export function emptyRegistry() {
  const now = new Date().toISOString();
  return {
    version: REGISTRY_VERSION,
    createdAt: now,
    updatedAt: now,
    summary: null,
    teams: [],
    tasks: [],
    assignments: [],
  };
}

function validateRegistry(registry) {
  if (!registry || registry.version !== REGISTRY_VERSION) {
    throw new FleetError("The registry version is not supported.", "registry_invalid");
  }
  for (const key of ["teams", "tasks", "assignments"]) {
    if (!Array.isArray(registry[key])) {
      throw new FleetError(`The registry field ${key} must be an array.`, "registry_invalid");
    }
  }
  return registry;
}

async function writeAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await open(temporary, "wx").then(async (handle) => {
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
  await rename(temporary, path);
}

function leaseRecord(lease) {
  return { version: lease.version, ownerId: lease.ownerId, expiresAt: lease.expiresAt };
}

async function readLease(path) {
  try {
    const lease = JSON.parse(await readFile(path, "utf8"));
    if (
      lease.version !== COORDINATOR_LEASE_VERSION ||
      typeof lease.ownerId !== "string" ||
      !Number.isFinite(lease.expiresAt)
    ) {
      throw new FleetError("The coordinator lease is not supported.", "coordinator_lease_invalid");
    }
    return lease;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof FleetError) throw error;
    throw new FleetError("The coordinator lease is not valid JSON.", "coordinator_lease_invalid", {
      cause: error,
    });
  }
}

export class RegistryStore {
  constructor(root) {
    this.root = root;
    this.registryPath = join(root, "registry.json");
    this.eventsPath = join(root, "events.jsonl");
    this.deliveryPath = join(root, "delivery.json");
    this.coordinatorLeasePath = join(root, "coordinator.json");
    this.lockPath = join(root, "registry.lock");
  }

  async init() {
    await mkdir(this.root, { recursive: true });
    try {
      return await this.read();
    } catch (error) {
      if (error.code !== "registry_not_found") throw error;
    }
    const registry = emptyRegistry();
    await writeAtomic(this.registryPath, registry);
    return registry;
  }

  async read() {
    let source;
    try {
      source = await readFile(this.registryPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new FleetError(
          `No fleet registry exists at ${this.registryPath}. Run pi-fleet init first.`,
          "registry_not_found",
          { cause: error },
        );
      }
      throw error;
    }
    try {
      return validateRegistry(JSON.parse(source));
    } catch (error) {
      if (error instanceof FleetError) throw error;
      throw new FleetError(`The registry at ${this.registryPath} is not valid JSON.`, "registry_invalid", {
        cause: error,
      });
    }
  }

  async acquireLock() {
    const started = Date.now();
    await mkdir(this.root, { recursive: true });
    while (true) {
      try {
        return await open(this.lockPath, "wx");
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const details = await stat(this.lockPath);
          if (Date.now() - details.mtimeMs > STALE_LOCK_MS) {
            await unlink(this.lockPath);
            continue;
          }
        } catch (statError) {
          if (statError.code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() - started >= LOCK_TIMEOUT_MS) {
          throw new FleetError("The registry lock did not become available.", "registry_lock_timeout");
        }
        await delay(50);
      }
    }
  }

  async withLock(operation) {
    const lock = await this.acquireLock();
    try {
      return await operation();
    } finally {
      await lock.close();
      try {
        await unlink(this.lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  async update(mutator) {
    const lock = await this.acquireLock();
    try {
      const before = await this.read();
      const after = structuredClone(before);
      const result = await mutator(after);
      if (JSON.stringify(before) === JSON.stringify(after)) return result;
      after.updatedAt = new Date().toISOString();
      await writeAtomic(this.registryPath, after);
      await this.appendTransitions(before, after);
      return result;
    } finally {
      await lock.close();
      try {
        await unlink(this.lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  async appendTransitions(before, after) {
    const events = [];
    const timestamp = after.updatedAt;
    for (const assignment of after.assignments) {
      const previous = before.assignments.find((item) => item.id === assignment.id);
      if (!previous) {
        events.push(this.event("assignment.created", assignment, null, assignment.status, timestamp));
      } else if (previous.status !== assignment.status) {
        events.push(
          this.event("assignment.changed", assignment, previous.status, assignment.status, timestamp),
        );
      }
    }
    for (const team of after.teams) {
      if (!before.teams.some((item) => item.name === team.name)) {
        events.push({ id: newEventId(), timestamp, type: "team.created", team: team.name });
      }
    }
    for (const task of after.tasks) {
      if (!before.tasks.some((item) => item.id === task.id)) {
        events.push({ id: newEventId(), timestamp, type: "task.created", taskId: task.id, taskCard: task.taskCard });
      }
    }
    if (events.length > 0) {
      await appendFile(this.eventsPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    }
  }

  event(type, assignment, from, to, timestamp) {
    return {
      id: newEventId(),
      timestamp,
      type,
      assignmentId: assignment.id,
      agent: assignment.name,
      team: assignment.team,
      from,
      to,
    };
  }

  async initializeDelivery() {
    const lock = await this.acquireLock();
    try {
      if (await this.readDelivery()) return false;
      const events = await this.readEvents();
      await writeAtomic(this.deliveryPath, {
        version: DELIVERY_VERSION,
        handledEventIds: [...new Set(events.map(registryEventId))],
      });
      return true;
    } finally {
      await lock.close();
      try {
        await unlink(this.lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  async readDelivery() {
    try {
      const state = JSON.parse(await readFile(this.deliveryPath, "utf8"));
      if (state.version !== DELIVERY_VERSION || !Array.isArray(state.handledEventIds)) {
        throw new FleetError("The delivery state is not supported.", "delivery_invalid");
      }
      return state;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error instanceof FleetError) throw error;
      throw new FleetError("The delivery state is not valid JSON.", "delivery_invalid", { cause: error });
    }
  }

  async markEventsHandled(eventIds) {
    if (eventIds.length === 0) return;
    const lock = await this.acquireLock();
    try {
      const current = (await this.readDelivery()) ?? { version: DELIVERY_VERSION, handledEventIds: [] };
      const handledEventIds = new Set(current.handledEventIds);
      for (const id of eventIds) handledEventIds.add(id);
      if (handledEventIds.size === current.handledEventIds.length) return;
      await writeAtomic(this.deliveryPath, {
        version: DELIVERY_VERSION,
        handledEventIds: [...handledEventIds],
      });
    } finally {
      await lock.close();
      try {
        await unlink(this.lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  async acquireCoordinatorLease({ leaseMs = DEFAULT_COORDINATOR_LEASE_MS } = {}) {
    await mkdir(this.root, { recursive: true });
    return this.withLock(async () => {
      if (!(await this.recoverStaleCoordinatorLeaseUnlocked(leaseMs))) return null;
      const lease = {
        version: COORDINATOR_LEASE_VERSION,
        ownerId: randomUUID(),
        expiresAt: Date.now() + leaseMs,
        handle: null,
      };
      await writeAtomic(this.coordinatorLeasePath, leaseRecord(lease));
      lease.handle = await open(this.coordinatorLeasePath, "r");
      return lease;
    });
  }

  async recoverStaleCoordinatorLease(leaseMs) {
    return this.withLock(() => this.recoverStaleCoordinatorLeaseUnlocked(leaseMs));
  }

  async recoverStaleCoordinatorLeaseUnlocked(leaseMs) {
    const now = Date.now();
    let observed;
    try {
      observed = await this.readCoordinatorLease();
    } catch (error) {
      if (error.code !== "coordinator_lease_invalid") throw error;
    }
    if (observed && observed.expiresAt > now) return false;
    if (!observed) {
      let details;
      try {
        details = await stat(this.coordinatorLeasePath);
      } catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
      }
      if (now - details.mtimeMs <= leaseMs) return false;
    }

    try {
      await unlink(this.coordinatorLeasePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return true;
  }

  async renewCoordinatorLease(lease, leaseMs = DEFAULT_COORDINATOR_LEASE_MS) {
    return this.withLock(async () => {
      if (!(await this.ownsCoordinatorLeaseUnlocked(lease))) return false;
      const expiresAt = Date.now() + leaseMs;
      await writeAtomic(this.coordinatorLeasePath, leaseRecord({ ...lease, expiresAt }));
      lease.expiresAt = expiresAt;
      return true;
    });
  }

  async ownsCoordinatorLeaseUnlocked(lease) {
    if (!lease?.handle) return false;
    try {
      await lease.handle.stat();
      const current = await this.readCoordinatorLease();
      return current?.ownerId === lease.ownerId;
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EBADF") return false;
      throw error;
    }
  }

  async ownsCoordinatorLease(lease) {
    return this.withLock(() => this.ownsCoordinatorLeaseUnlocked(lease));
  }

  async runWithCoordinatorLease(lease, operation) {
    return this.withLock(async () => {
      if (!(await this.ownsCoordinatorLeaseUnlocked(lease))) return false;
      return (await operation()) !== false;
    });
  }

  async releaseCoordinatorLease(lease) {
    if (!lease?.handle) return false;
    return this.withLock(async () => {
      try {
        if (!(await this.ownsCoordinatorLeaseUnlocked(lease))) return false;
        try {
          await unlink(this.coordinatorLeasePath);
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
        return true;
      } finally {
        await lease.handle.close().catch((error) => {
          if (error.code !== "EBADF") throw error;
        });
      }
    });
  }

  async readCoordinatorLease() {
    try {
      return await readLease(this.coordinatorLeasePath);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async readEvents() {
    try {
      const source = await readFile(this.eventsPath, "utf8");
      return source
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
}

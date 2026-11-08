import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, stat, unlink, appendFile, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lock as acquireFileLock } from "proper-lockfile";
import { FleetError } from "./errors.js";

const REGISTRY_VERSION = 1;
const REGISTRY_LOCK_VERSION = 1;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const DELIVERY_VERSION = 1;
const COORDINATOR_LEASE_VERSION = 1;
const DEFAULT_COORDINATOR_LEASE_MS = 10_000;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function registryEventId(event) {
  if (event.id) return event.id;
  const digest = createHash("sha256").update(JSON.stringify(canonicalValue(event))).digest("hex");
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

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
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
  constructor(
    root,
    {
      now = Date.now,
      isProcessAlive = processIsAlive,
      staleLockMs = STALE_LOCK_MS,
      lockTimeoutMs = LOCK_TIMEOUT_MS,
      lockRetryMs = 50,
    } = {},
  ) {
    this.root = root;
    this.registryPath = join(root, "registry.json");
    this.eventsPath = join(root, "events.jsonl");
    this.deliveryPath = join(root, "delivery.json");
    this.coordinatorLeasePath = join(root, "coordinator.json");
    this.lockPath = join(root, "registry.lock");
    this.recoveryPath = join(root, "registry.lock.recovery");
    this.now = now;
    this.isProcessAlive = isProcessAlive;
    this.staleLockMs = staleLockMs;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockRetryMs = lockRetryMs;
  }

  async init() {
    await mkdir(this.root, { recursive: true });
    try {
      return await this.read();
    } catch (error) {
      if (error.code !== "registry_not_found") throw error;
    }
    return this.withLock(async () => {
      try {
        return await this.read();
      } catch (error) {
        if (error.code !== "registry_not_found") throw error;
      }
      const registry = emptyRegistry();
      await writeAtomic(this.registryPath, registry);
      return registry;
    });
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

  newLockOwner() {
    return {
      version: REGISTRY_LOCK_VERSION,
      pid: process.pid,
      ownerToken: randomUUID(),
      createdAt: new Date(this.now()).toISOString(),
    };
  }

  async createLock(path) {
    const owner = this.newLockOwner();
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(path).catch((unlinkError) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
      throw error;
    }
    handle.ownerToken = owner.ownerToken;
    return handle;
  }

  async readLockOwner(path) {
    let source;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    try {
      const owner = JSON.parse(source);
      if (
        owner.version !== REGISTRY_LOCK_VERSION ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        typeof owner.ownerToken !== "string" ||
        owner.ownerToken.length === 0 ||
        !Number.isFinite(Date.parse(owner.createdAt))
      ) {
        return null;
      }
      return owner;
    } catch {
      return null;
    }
  }

  async shouldRecoverLock(path) {
    const owner = await this.readLockOwner(path);
    let createdAt = Date.parse(owner?.createdAt);
    if (!Number.isFinite(createdAt)) {
      let details;
      try {
        details = await stat(path);
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
      createdAt = details.mtimeMs;
    }
    if (this.now() - createdAt <= this.staleLockMs) return false;
    if (!owner) return true;
    return !(await this.isProcessAlive(owner.pid, owner));
  }

  async removeStaleLock(path) {
    if (!(await this.shouldRecoverLock(path))) return false;
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async acquireRecoveryGuard() {
    const retries = this.lockTimeoutMs <= 0 ? 0 : Math.ceil(this.lockTimeoutMs / this.lockRetryMs);
    try {
      return await acquireFileLock(this.root, {
        lockfilePath: this.recoveryPath,
        realpath: false,
        stale: 5000,
        update: 1000,
        retries: {
          retries,
          factor: 1,
          minTimeout: this.lockRetryMs,
          maxTimeout: this.lockRetryMs,
        },
      });
    } catch (error) {
      if (error.code === "ELOCKED") {
        throw new FleetError("The registry recovery guard did not become available.", "registry_lock_timeout", {
          cause: error,
        });
      }
      throw error;
    }
  }

  async acquireLock() {
    const started = this.now();
    await mkdir(this.root, { recursive: true });
    while (true) {
      const releaseGuard = await this.acquireRecoveryGuard();
      let recovered = false;
      try {
        try {
          return await this.createLock(this.lockPath);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          recovered = await this.removeStaleLock(this.lockPath);
        }
      } finally {
        await releaseGuard();
      }
      if (recovered) continue;
      if (this.now() - started >= this.lockTimeoutMs) {
        throw new FleetError("The registry lock did not become available.", "registry_lock_timeout");
      }
      await delay(this.lockRetryMs);
    }
  }

  async releaseLock(lock) {
    await lock.close();
    const releaseGuard = await this.acquireRecoveryGuard();
    try {
      const owner = await this.readLockOwner(this.lockPath);
      if (owner?.ownerToken !== lock.ownerToken) return false;
      try {
        await unlink(this.lockPath);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    } finally {
      await releaseGuard();
    }
  }

  async withLock(operation) {
    const lock = await this.acquireLock();
    try {
      return await operation();
    } finally {
      await this.releaseLock(lock);
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
      await this.releaseLock(lock);
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
      await this.repairEventsTail();
      await appendFile(this.eventsPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    }
  }

  async repairEventsTail() {
    let source;
    try {
      source = await readFile(this.eventsPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!source || source.endsWith("\n")) return;
    const boundary = source.lastIndexOf("\n") + 1;
    try {
      JSON.parse(source.slice(boundary));
      await appendFile(this.eventsPath, "\n", "utf8");
    } catch {
      await truncate(this.eventsPath, boundary);
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
      await this.releaseLock(lock);
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
      await this.releaseLock(lock);
    }
  }

  async acquireCoordinatorLease({ leaseMs = DEFAULT_COORDINATOR_LEASE_MS } = {}) {
    await mkdir(this.root, { recursive: true });
    return this.withLock(async () => {
      if (!(await this.recoverStaleCoordinatorLeaseUnlocked(leaseMs))) return null;
      const lease = {
        version: COORDINATOR_LEASE_VERSION,
        ownerId: randomUUID(),
        expiresAt: this.now() + leaseMs,
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
    const now = this.now();
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
      const expiresAt = this.now() + leaseMs;
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
      const lines = source.split("\n");
      const events = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line) continue;
        try {
          events.push(JSON.parse(line));
        } catch (error) {
          if (index === lines.length - 1 && !source.endsWith("\n")) break;
          throw new FleetError("The registry event log is not valid JSON.", "events_invalid", { cause: error });
        }
      }
      return events;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
}

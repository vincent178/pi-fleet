import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, mkdir, readFile, rename, stat, unlink, appendFile, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { flock } from "fs-ext";
import { FleetError } from "./errors.js";

const REGISTRY_VERSION = 1;
const REGISTRY_LOCK_VERSION = 1;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const DELIVERY_VERSION = 1;
const DELIVERY_HISTORY_LIMIT = 1000;
const COORDINATOR_LEASE_VERSION = 1;
const DEFAULT_COORDINATOR_LEASE_MS = 10_000;
const execFileAsync = promisify(execFile);
const flockAsync = promisify(flock);

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

async function writeTextAtomic(path, source) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await open(temporary, "wx").then(async (handle) => {
    try {
      await handle.writeFile(source, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
  await rename(temporary, path);
}

async function writeAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function leaseRecord(lease) {
  return { version: lease.version, ownerId: lease.ownerId, expiresAt: lease.expiresAt };
}

async function processStartIdentity(pid) {
  try {
    const source = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = source.slice(source.lastIndexOf(")") + 2).split(" ");
    if (fields[19]) return `proc:${fields[19]}`;
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5000 }));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const identity = stdout.trim();
  if (!identity) {
    throw new FleetError("The process start identity is unavailable.", "process_start_unavailable");
  }
  return `ps:${identity}`;
}

async function processMatchesOwner(pid, owner, getProcessStartIdentity) {
  try {
    process.kill(pid, 0);
    if (!owner.processStartId) return true;
    const identity = await getProcessStartIdentity(pid);
    if (!identity) return true;
    return identity === owner.processStartId;
  } catch (error) {
    if (error.code === "ESRCH" || error.code === "ENOENT") return false;
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
      isProcessAlive,
      getProcessStartIdentity = processStartIdentity,
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
    this.getProcessStartIdentity = getProcessStartIdentity;
    this.isProcessAlive =
      isProcessAlive ?? ((pid, owner) => processMatchesOwner(pid, owner, this.getProcessStartIdentity));
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

  async newLockOwner() {
    return {
      version: REGISTRY_LOCK_VERSION,
      pid: process.pid,
      ownerToken: randomUUID(),
      createdAt: new Date(this.now()).toISOString(),
      processStartId: await this.getProcessStartIdentity(process.pid),
    };
  }

  async createLock(path) {
    const owner = await this.newLockOwner();
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
        !Number.isFinite(Date.parse(owner.createdAt)) ||
        (owner.processStartId != null && typeof owner.processStartId !== "string")
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
    const started = this.now();
    while (true) {
      const handle = await open(this.recoveryPath, "a");
      try {
        await flockAsync(handle.fd, "exnb");
        return async () => {
          try {
            await flockAsync(handle.fd, "un");
          } finally {
            await handle.close();
          }
        };
      } catch (error) {
        await handle.close();
        if (error.code !== "EAGAIN" && error.code !== "EWOULDBLOCK") throw error;
      }
      if (this.now() - started >= this.lockTimeoutMs) {
        throw new FleetError("The registry recovery guard did not become available.", "registry_lock_timeout");
      }
      await delay(this.lockRetryMs);
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
      const eventTail = await this.readEventsTail();
      try {
        await this.appendTransitions(before, after);
        await writeAtomic(this.registryPath, after);
      } catch (error) {
        try {
          await truncate(this.eventsPath, eventTail.boundary);
          await appendFile(this.eventsPath, eventTail.tail);
        } catch (rollbackError) {
          if (rollbackError.code !== "ENOENT") {
            throw new FleetError("The registry event-log rollback failed.", "registry_rollback_failed", {
              cause: rollbackError,
            });
          }
        }
        throw error;
      }
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
      const separator = (await this.repairEventsTail()) ? "\n" : "";
      await appendFile(this.eventsPath, separator + events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    }
  }

  async readEventsTail() {
    let details;
    try {
      details = await stat(this.eventsPath);
    } catch (error) {
      if (error.code === "ENOENT") return { boundary: 0, tail: Buffer.alloc(0) };
      throw error;
    }
    if (details.size === 0) return { boundary: 0, tail: Buffer.alloc(0) };
    const handle = await open(this.eventsPath, "r");
    let position = details.size;
    let boundary = 0;
    let tail = Buffer.alloc(0);
    try {
      while (position > 0) {
        const start = Math.max(0, position - 64 * 1024);
        const buffer = Buffer.alloc(position - start);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        tail = Buffer.concat([buffer.subarray(0, bytesRead), tail]);
        const newline = tail.lastIndexOf(10);
        if (newline >= 0) {
          boundary = start + newline + 1;
          tail = tail.subarray(newline + 1);
          break;
        }
        position = start;
      }
    } finally {
      await handle.close();
    }
    return { boundary, tail };
  }

  async repairEventsTail() {
    const { boundary, tail } = await this.readEventsTail();
    if (tail.length === 0 || tail[tail.length - 1] === 10) return false;
    try {
      JSON.parse(tail.toString("utf8"));
      return true;
    } catch {
      await truncate(this.eventsPath, boundary);
      return false;
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
      if (handledEventIds.size > DELIVERY_HISTORY_LIMIT) await this.compactDelivery(handledEventIds);
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

  async compactDelivery(handledEventIds) {
    const events = await this.readEvents();
    const pendingIds = new Set(
      events.filter((event) => !handledEventIds.has(registryEventId(event))).map(registryEventId),
    );
    const retainedIds = new Set([...events.slice(-DELIVERY_HISTORY_LIMIT).map(registryEventId), ...pendingIds]);
    const retainedEvents = events.filter((event) => retainedIds.has(registryEventId(event)));
    const source = retainedEvents.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await writeTextAtomic(this.eventsPath, source);
    await writeAtomic(this.deliveryPath, {
      version: DELIVERY_VERSION,
      handledEventIds: [...handledEventIds].filter((id) => retainedIds.has(id)),
    });
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

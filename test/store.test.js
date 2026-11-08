import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { RegistryStore, registryEventId } from "../src/store.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function storeFixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RegistryStore(root, options);
  await store.init();
  return store;
}

test("registry writes survive concurrent updates", async (t) => {
  const store = await storeFixture(t);
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.update(async (registry) => {
        await delay(index % 3);
        registry.teams.push({ name: `team-${index}`, status: "active" });
      }),
    ),
  );
  const registry = await store.read();
  assert.equal(registry.teams.length, 20);
  assert.equal(new Set(registry.teams.map((team) => team.name)).size, 20);
});

test("no-op updates retain the registry timestamp", async (t) => {
  const store = await storeFixture(t);
  const before = await store.read();
  await delay(10);
  await store.update(() => {});
  const after = await store.read();
  assert.equal(after.updatedAt, before.updatedAt);
});

test("registry mutex records identify the process and a unique owner token", async (t) => {
  const store = await storeFixture(t);
  const first = await store.acquireLock();
  const firstRecord = JSON.parse(await readFile(store.lockPath, "utf8"));
  assert.equal(firstRecord.version, 1);
  assert.equal(firstRecord.pid, process.pid);
  assert.equal(firstRecord.ownerToken, first.ownerToken);
  assert.match(firstRecord.ownerToken, /^[a-f0-9-]{36}$/);
  assert.equal(Number.isFinite(Date.parse(firstRecord.createdAt)), true);
  assert.equal(await store.releaseLock(first), true);

  const second = await store.acquireLock();
  const secondRecord = JSON.parse(await readFile(store.lockPath, "utf8"));
  assert.notEqual(secondRecord.ownerToken, firstRecord.ownerToken);
  assert.equal(await store.releaseLock(second), true);
});

test("a live registry mutex owner excludes recovery beyond the stale threshold", async (t) => {
  let now = Date.now();
  const options = { now: () => now, isProcessAlive: () => true };
  const ownerStore = await storeFixture(t, options);
  const owner = await ownerStore.acquireLock();
  const original = JSON.parse(await readFile(ownerStore.lockPath, "utf8"));
  now += 30_001;
  const contender = new RegistryStore(ownerStore.root, { ...options, lockTimeoutMs: 0 });
  await assert.rejects(contender.acquireLock(), { code: "registry_lock_timeout" });
  assert.deepEqual(JSON.parse(await readFile(ownerStore.lockPath, "utf8")), original);
  assert.equal(await ownerStore.releaseLock(owner), true);
});

test("a dead registry mutex owner permits recovery beyond the stale threshold", async (t) => {
  let now = Date.now();
  const ownerStore = await storeFixture(t, { now: () => now });
  const stale = await ownerStore.acquireLock();
  const staleToken = stale.ownerToken;
  now += 30_001;
  const contender = new RegistryStore(ownerStore.root, {
    now: () => now,
    isProcessAlive: () => false,
    lockTimeoutMs: 0,
  });
  const replacement = await contender.acquireLock();
  const current = JSON.parse(await readFile(contender.lockPath, "utf8"));
  assert.notEqual(current.ownerToken, staleToken);
  assert.equal(current.ownerToken, replacement.ownerToken);
  assert.equal(await contender.releaseLock(replacement), true);
  assert.equal(await ownerStore.releaseLock(stale), false);
});

test("registry mutex release cannot remove a replacement owner", async (t) => {
  let now = Date.now();
  const oldStore = await storeFixture(t, { now: () => now });
  const old = await oldStore.acquireLock();
  now += 30_001;
  const replacementStore = new RegistryStore(oldStore.root, {
    now: () => now,
    isProcessAlive: () => false,
  });
  const replacement = await replacementStore.acquireLock();
  const replacementRecord = JSON.parse(await readFile(replacementStore.lockPath, "utf8"));
  assert.equal(await oldStore.releaseLock(old), false);
  assert.deepEqual(JSON.parse(await readFile(replacementStore.lockPath, "utf8")), replacementRecord);
  assert.equal(await replacementStore.releaseLock(replacement), true);
});

test("concurrent stale registry mutex recovery permits one replacement owner", async (t) => {
  let offset = 0;
  const now = () => Date.now() + offset;
  const oldStore = await storeFixture(t, { now });
  const stale = await oldStore.acquireLock();
  const staleToken = stale.ownerToken;
  offset = 30_001;
  const stores = Array.from(
    { length: 8 },
    () =>
      new RegistryStore(oldStore.root, {
        now,
        isProcessAlive: (_pid, owner) => owner.ownerToken !== staleToken,
        lockTimeoutMs: 30,
        lockRetryMs: 1,
      }),
  );
  const results = await Promise.allSettled(stores.map((store) => store.acquireLock()));
  const winners = results.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  for (const result of results) {
    if (result.status === "rejected") assert.equal(result.reason.code, "registry_lock_timeout");
  }
  const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
  const winnerStore = stores[winnerIndex];
  const winner = winners[0].value;
  assert.equal(JSON.parse(await readFile(winnerStore.lockPath, "utf8")).ownerToken, winner.ownerToken);
  assert.equal(await oldStore.releaseLock(stale), false);
  assert.equal(JSON.parse(await readFile(winnerStore.lockPath, "utf8")).ownerToken, winner.ownerToken);
  assert.equal(await winnerStore.releaseLock(winner), true);
});

test("concurrent stale recovery-guard recovery permits one replacement owner", async (t) => {
  let offset = 0;
  const now = () => Date.now() + offset;
  const oldStore = await storeFixture(t, { now });
  const stale = await oldStore.acquireLock();
  const staleToken = stale.ownerToken;
  await mkdir(oldStore.recoveryPath);
  const staleTime = new Date(Date.now() - 10_000);
  await utimes(oldStore.recoveryPath, staleTime, staleTime);
  offset = 30_001;
  const stores = Array.from(
    { length: 8 },
    () =>
      new RegistryStore(oldStore.root, {
        now,
        isProcessAlive: (_pid, owner) => owner.ownerToken !== staleToken,
        lockTimeoutMs: 100,
        lockRetryMs: 1,
      }),
  );
  const results = await Promise.allSettled(stores.map((store) => store.acquireLock()));
  const winners = results.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
  const winnerStore = stores[winnerIndex];
  const winner = winners[0].value;
  assert.equal(await oldStore.releaseLock(stale), false);
  assert.equal(await winnerStore.releaseLock(winner), true);
});

test("a crashed recovery guard cannot strand a new registry owner", async (t) => {
  const store = await storeFixture(t, { lockTimeoutMs: 2000, lockRetryMs: 20 });
  await mkdir(store.recoveryPath);
  const recentCrash = new Date(Date.now() - 4500);
  await utimes(store.recoveryPath, recentCrash, recentCrash);
  const lock = await store.acquireLock();
  assert.equal(await store.releaseLock(lock), true);
});

test("coordinator lease acquisition is atomic and release permits a new owner", async (t) => {
  const firstStore = await storeFixture(t);
  const secondStore = new RegistryStore(firstStore.root);
  const [first, second] = await Promise.all([
    firstStore.acquireCoordinatorLease(),
    secondStore.acquireCoordinatorLease(),
  ]);
  const owner = first ?? second;
  const rejected = first ? second : first;
  t.after(() => firstStore.releaseCoordinatorLease(owner));
  assert.ok(owner);
  assert.equal(rejected, null);
  assert.equal(await firstStore.releaseCoordinatorLease(owner), true);
  const replacement = await secondStore.acquireCoordinatorLease();
  t.after(() => secondStore.releaseCoordinatorLease(replacement));
  assert.ok(replacement);
  assert.notEqual(replacement.ownerId, owner.ownerId);
});

test("stale lease recovery fences the old owner and preserves the replacement", async (t) => {
  const store = await storeFixture(t);
  const stale = await store.acquireCoordinatorLease({ leaseMs: 30 });
  t.after(() => store.releaseCoordinatorLease(stale));
  await delay(60);
  const replacement = await store.acquireCoordinatorLease();
  t.after(() => store.releaseCoordinatorLease(replacement));
  assert.ok(replacement);
  assert.notEqual(replacement.ownerId, stale.ownerId);
  assert.equal(await store.ownsCoordinatorLease(stale), false);
  assert.equal(await store.releaseCoordinatorLease(stale), false);
  assert.equal((await store.readCoordinatorLease()).ownerId, replacement.ownerId);
});

test("concurrent stale recovery permits one coordinator acquisition", async (t) => {
  const store = await storeFixture(t);
  const stale = await store.acquireCoordinatorLease({ leaseMs: 25 });
  const stores = Array.from({ length: 8 }, () => new RegistryStore(store.root));
  let leases = [];
  t.after(async () => {
    await store.releaseCoordinatorLease(stale);
    await Promise.all(leases.map((lease, index) => stores[index].releaseCoordinatorLease(lease)));
  });
  await delay(55);
  leases = await Promise.all(stores.map((item) => item.acquireCoordinatorLease({ leaseMs: 500 })));
  const winners = leases.filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal(await store.ownsCoordinatorLease(stale), false);
  assert.equal(await store.releaseCoordinatorLease(stale), false);
  assert.equal((await store.readCoordinatorLease()).ownerId, winners[0].ownerId);
});

test("coordinator lease renewal extends expiry without changing ownership", async (t) => {
  const store = await storeFixture(t);
  const lease = await store.acquireCoordinatorLease({ leaseMs: 100 });
  t.after(() => store.releaseCoordinatorLease(lease));
  const initialExpiry = lease.expiresAt;
  await delay(20);
  assert.equal(await store.renewCoordinatorLease(lease, 200), true);
  assert.ok(lease.expiresAt > initialExpiry);
  assert.equal((await store.readCoordinatorLease()).ownerId, lease.ownerId);
  assert.equal(await store.acquireCoordinatorLease(), null);
});

test("coordinator lease renewal exposes valid JSON to concurrent readers", async (t) => {
  const store = await storeFixture(t);
  const lease = await store.acquireCoordinatorLease({ leaseMs: 500 });
  t.after(() => store.releaseCoordinatorLease(lease));
  const truncated = deferred();
  const resume = deferred();
  const write = lease.handle.write.bind(lease.handle);
  lease.handle.write = async (...args) => {
    truncated.resolve();
    await resume.promise;
    return write(...args);
  };
  const renewing = store.renewCoordinatorLease(lease, 500);
  await Promise.race([truncated.promise, renewing]);
  let current;
  let error;
  try {
    current = await store.readCoordinatorLease();
  } catch (caught) {
    error = caught;
  } finally {
    resume.resolve();
  }
  assert.equal(await renewing, true);
  assert.ifError(error);
  assert.equal(current.ownerId, lease.ownerId);
  assert.equal(Number.isFinite(current.expiresAt), true);
});

test("assignment transitions append JSONL events", async (t) => {
  const store = await storeFixture(t);
  await store.update((registry) => {
    registry.assignments.push({ id: "asg_1", name: "w-a", team: "team-a", status: "pending" });
  });
  await store.update((registry) => {
    registry.assignments[0].status = "dispatched";
  });
  const events = await store.readEvents();
  assert.deepEqual(events.map((event) => event.type), ["assignment.created", "assignment.changed"]);
  assert.equal(events[1].from, "pending");
  assert.equal(events[1].to, "dispatched");
  assert.equal(new Set(events.map((event) => event.id)).size, events.length);
  for (const event of events) assert.match(event.id, /^evt_[a-f0-9]{32}$/);
  const legacy = { timestamp: "2026-01-01T00:00:00.000Z", type: "team.created", team: "team-a" };
  assert.equal(registryEventId(legacy), registryEventId({ ...legacy }));
  assert.match(registryEventId(legacy), /^legacy_[a-f0-9]{64}$/);
});

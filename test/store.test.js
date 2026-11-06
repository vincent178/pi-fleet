import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { RegistryStore, registryEventId } from "../src/store.js";

async function storeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RegistryStore(root);
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

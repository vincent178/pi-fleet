import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Fleet } from "../src/fleet.js";
import { FleetError } from "../src/errors.js";
import { FakeHerdr } from "./fake-herdr.js";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-fleet-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const taskCard = join(cwd, "task.md");
  await writeFile(taskCard, "# Task\n", "utf8");
  const herdr = new FakeHerdr();
  const fleet = new Fleet({ cwd, root: ".fleet", herdr });
  await fleet.init({ noUi: true });
  return { cwd, taskCard, herdr, fleet };
}

test("init creates one summary pane and remains idempotent", async (t) => {
  const { fleet, herdr } = await fixture(t);
  await fleet.init();
  await fleet.init();
  assert.equal(herdr.calls.filter((call) => call.name === "splitPane").length, 1);
  assert.equal(herdr.commands.length, 1);
  assert.match(herdr.commands[0].command, /status/);
  assert.match(herdr.commands[0].command, /--watch/);
});

test("worker dispatch creates a task tab and returns after prompt delivery", async (t) => {
  const { fleet, herdr, taskCard } = await fixture(t);
  await fleet.createTeam({ name: "team-a", noUi: true });
  const assignment = await fleet.dispatch({ team: "team-a", task: taskCard });
  assert.equal(assignment.status, "dispatched");
  assert.equal(assignment.role, "worker");
  assert.equal(herdr.agents.get(assignment.name).agent, "pi");
  assert.ok(assignment.paneId);
  assert.equal(herdr.prompts.length, 1);
  assert.match(herdr.prompts[0].prompt, new RegExp(taskCard.replaceAll("/", "\\/")));
  const registry = await fleet.store.read();
  assert.equal(registry.tasks[0].ownsTab, true);
  assert.equal(registry.tasks[0].tabId, assignment.tabId);
});

test("worker limit rejects excess active assignments", async (t) => {
  const { fleet, cwd, taskCard } = await fixture(t);
  await fleet.createTeam({ name: "team-a", workerLimit: 1, noUi: true });
  await fleet.dispatch({ team: "team-a", task: taskCard });
  const secondTask = join(cwd, "second.md");
  await writeFile(secondTask, "# Second\n");
  await assert.rejects(fleet.dispatch({ team: "team-a", task: secondTask }), { code: "worker_limit" });
  assert.equal((await fleet.store.read()).assignments.length, 1);
});

test("verifier shares the task tab and creates a command pane", async (t) => {
  const { fleet, herdr, taskCard } = await fixture(t);
  await fleet.createTeam({ name: "team-a", noUi: true });
  const worker = await fleet.dispatch({ team: "team-a", task: taskCard });
  const verifier = await fleet.dispatch({ team: "team-a", task: taskCard, role: "verifier" });
  assert.equal(verifier.tabId, worker.tabId);
  assert.notEqual(verifier.paneId, worker.paneId);
  const task = (await fleet.store.read()).tasks[0];
  assert.ok(task.commandPaneId);
  const directions = herdr.calls.filter((call) => call.name === "splitPane").map((call) => call.value.direction);
  assert.deepEqual(directions, ["right", "down"]);
});

test("verifier requires a worker and rejects duplicate roles", async (t) => {
  const { fleet, taskCard } = await fixture(t);
  await fleet.createTeam({ name: "team-a", noUi: true });
  await assert.rejects(fleet.dispatch({ team: "team-a", task: taskCard, role: "verifier" }), {
    code: "worker_required",
  });
  await fleet.dispatch({ team: "team-a", task: taskCard });
  await fleet.dispatch({ team: "team-a", task: taskCard, role: "verifier" });
  await assert.rejects(fleet.dispatch({ team: "team-a", task: taskCard, role: "verifier" }), {
    code: "role_exists",
  });
});

test("Herdr done maps to settled and release closes the task tab", async (t) => {
  const { fleet, herdr, taskCard } = await fixture(t);
  await fleet.createTeam({ name: "team-a", noUi: true });
  const assignment = await fleet.dispatch({ team: "team-a", task: taskCard });
  herdr.agents.get(assignment.name).agent_status = "done";
  const snapshot = await fleet.status();
  assert.equal(snapshot.assignments[0].status, "settled");
  assert.equal(snapshot.teams[0].activeWorkers, 0);
  const released = await fleet.release(assignment.id);
  assert.equal(released.status, "released");
  assert.deepEqual(herdr.closedTabs, [assignment.tabId]);
  assert.equal((await fleet.store.read()).tasks[0].status, "released");
});

test("refresh follows an assignment moved to another pane", async (t) => {
  const { fleet, herdr, taskCard } = await fixture(t);
  await fleet.createTeam({ name: "team-a", noUi: true });
  const assignment = await fleet.dispatch({ team: "team-a", task: taskCard });
  Object.assign(herdr.agents.get(assignment.name), {
    pane_id: "w1:p99",
    tab_id: "w1:t99",
    workspace_id: "w1",
  });
  const snapshot = await fleet.status();
  assert.equal(snapshot.assignments[0].paneId, "w1:p99");
  assert.equal(snapshot.assignments[0].tabId, "w1:t99");
  assert.equal(snapshot.tasks[0].tabId, "w1:t99");
  assert.equal(snapshot.tasks[0].ownedTabId, assignment.tabId);
});

test("release closes the moved worker pane and the owned task tab", async (t) => {
  const { fleet, herdr, taskCard } = await fixture(t);
  await fleet.createTeam({ name: "team-a", noUi: true });
  const assignment = await fleet.dispatch({ team: "team-a", task: taskCard });
  const ownedTabId = assignment.tabId;
  herdr.panes.set("w1:p99", { pane_id: "w1:p99", tab_id: "w1:t99", workspace_id: "w1" });
  Object.assign(herdr.agents.get(assignment.name), {
    agent_status: "done",
    pane_id: "w1:p99",
    tab_id: "w1:t99",
    workspace_id: "w1",
  });
  await fleet.status();
  await fleet.release(assignment.id);
  assert.deepEqual(herdr.closedPanes, ["w1:p99"]);
  assert.deepEqual(herdr.closedTabs, [ownedTabId]);
});

test("release closes a verifier moved outside the owned task tab", async (t) => {
  const { fleet, herdr, taskCard } = await fixture(t);
  await fleet.createTeam({ name: "team-a", noUi: true });
  const worker = await fleet.dispatch({ team: "team-a", task: taskCard });
  const verifier = await fleet.dispatch({ team: "team-a", task: taskCard, role: "verifier" });
  const ownedTabId = (await fleet.store.read()).tasks[0].ownedTabId;
  herdr.panes.set("w1:p99", { pane_id: "w1:p99", tab_id: "w1:t99", workspace_id: "w1" });
  Object.assign(herdr.agents.get(worker.name), { agent_status: "done" });
  Object.assign(herdr.agents.get(verifier.name), {
    agent_status: "done",
    pane_id: "w1:p99",
    tab_id: "w1:t99",
    workspace_id: "w1",
  });
  await fleet.status();
  await fleet.release(worker.id);
  await fleet.release(verifier.id);
  assert.deepEqual(herdr.closedPanes, [worker.paneId, "w1:p99"]);
  assert.deepEqual(herdr.closedTabs, [ownedTabId]);
});

test("settled assignments resume when Herdr reports work", async (t) => {
  const { fleet, herdr, taskCard } = await fixture(t);
  await fleet.createTeam({ name: "team-a", noUi: true });
  const assignment = await fleet.dispatch({ team: "team-a", task: taskCard });
  herdr.agents.get(assignment.name).agent_status = "idle";
  const settled = await fleet.status();
  assert.equal(settled.assignments[0].status, "settled");
  assert.equal(settled.teams[0].activeWorkers, 0);
  herdr.agents.get(assignment.name).agent_status = "working";
  const working = await fleet.status();
  assert.equal(working.assignments[0].status, "working");
  assert.equal(working.teams[0].activeWorkers, 1);
});

test("settled assignments remain settled after agent exit", async (t) => {
  const { fleet, herdr, taskCard } = await fixture(t);
  await fleet.createTeam({ name: "team-a", noUi: true });
  const assignment = await fleet.dispatch({ team: "team-a", task: taskCard });
  herdr.agents.get(assignment.name).agent_status = "done";
  await fleet.status();
  herdr.agents.delete(assignment.name);
  const snapshot = await fleet.status();
  assert.equal(snapshot.assignments[0].status, "settled");
  assert.equal(snapshot.teams[0].activeWorkers, 0);
});

test("active release requires force", async (t) => {
  const { fleet, taskCard } = await fixture(t);
  await fleet.createTeam({ name: "team-a", noUi: true });
  const assignment = await fleet.dispatch({ team: "team-a", task: taskCard });
  await assert.rejects(fleet.release(assignment.id), { code: "assignment_active" });
  const released = await fleet.release(assignment.id, { force: true });
  assert.equal(released.status, "released");
});

test("wait returns a blocked assignment after a Herdr state change", async (t) => {
  const { fleet, herdr, taskCard } = await fixture(t);
  await fleet.createTeam({ name: "team-a", noUi: true });
  const assignment = await fleet.dispatch({ team: "team-a", task: taskCard });
  herdr.waitAction = (name, fake) => {
    fake.agents.get(name).agent_status = "blocked";
  };
  const result = await fleet.wait({ target: assignment.id, until: "blocked" });
  assert.equal(result.status, "changed");
  assert.equal(result.assignment.status, "blocked");
});

test("wait reports a Herdr timeout", async (t) => {
  const { fleet, herdr, taskCard } = await fixture(t);
  await fleet.createTeam({ name: "team-a", noUi: true });
  const assignment = await fleet.dispatch({ team: "team-a", task: taskCard });
  herdr.waitAction = () => {
    throw new FleetError("Herdr: timed out", "timeout");
  };
  const result = await fleet.wait({ target: assignment.id, timeoutMs: 1 });
  assert.equal(result.status, "timeout");
});

test("failed dispatch retains assignment evidence for cleanup", async (t) => {
  const { fleet, herdr, taskCard } = await fixture(t);
  await fleet.createTeam({ name: "team-a", noUi: true });
  herdr.promptAgent = async () => {
    throw new FleetError("Prompt failed", "agent_prompt_stalled");
  };
  await assert.rejects(fleet.dispatch({ team: "team-a", task: taskCard }), { code: "agent_prompt_stalled" });
  const assignment = (await fleet.store.read()).assignments[0];
  assert.equal(assignment.status, "failed");
  assert.ok(assignment.paneId);
  await fleet.release(assignment.id, { force: true });
  assert.equal((await fleet.store.read()).assignments[0].status, "released");
});

test("team creation adds no Herdr UI", async (t) => {
  const { fleet, herdr } = await fixture(t);
  const team = await fleet.createTeam({ name: "team-a" });
  assert.equal(team.status, "active");
  assert.equal(team.tabId, null);
  assert.equal(team.summaryPaneId, null);
  assert.equal(herdr.calls.filter((call) => call.name === "createTab").length, 0);
  assert.equal(herdr.commands.length, 0);
});

test("lead dispatch splits the fleet summary pane", async (t) => {
  const { fleet, herdr } = await fixture(t);
  await fleet.init();
  await fleet.createTeam({ name: "team-a" });
  const lead = await fleet.dispatch({ team: "team-a", role: "lead" });
  const registry = await fleet.store.read();
  const team = registry.teams[0];
  assert.equal(lead.tabId, "w1:t0");
  assert.equal(lead.taskCard, null);
  assert.equal(team.tabId, null);
  assert.equal(team.summaryPaneId, null);
  assert.equal(herdr.calls.filter((call) => call.name === "createTab").length, 0);
  const splits = herdr.calls.filter((call) => call.name === "splitPane");
  assert.equal(splits[1].value.paneId, registry.summary.paneId);
});

test("lead release preserves the coordinator and fleet summary", async (t) => {
  const { fleet, herdr } = await fixture(t);
  await fleet.init();
  await fleet.createTeam({ name: "team-a" });
  const lead = await fleet.dispatch({ team: "team-a", role: "lead" });
  const summary = (await fleet.store.read()).summary;
  herdr.agents.get(lead.name).agent_status = "done";
  await fleet.release(lead.id);
  assert.deepEqual(herdr.closedPanes, [lead.paneId]);
  assert.deepEqual(herdr.closedTabs, []);
  assert.ok(herdr.panes.has("w1:p0"));
  assert.ok(herdr.panes.has(summary.paneId));
});

test("lead dispatch validates the fleet summary before reservation", async (t) => {
  const { fleet } = await fixture(t);
  await fleet.createTeam({ name: "team-a" });
  await assert.rejects(fleet.dispatch({ team: "team-a", role: "lead" }), { code: "fleet_ui_missing" });
  assert.equal((await fleet.store.read()).assignments.length, 0);
  await fleet.init();
  const lead = await fleet.dispatch({ team: "team-a", role: "lead" });
  assert.equal(lead.status, "dispatched");
});

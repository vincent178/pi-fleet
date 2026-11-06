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

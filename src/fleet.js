import { randomUUID, createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FleetError, usageError } from "./errors.js";
import { HerdrClient } from "./herdr.js";
import { RegistryStore } from "./store.js";
import { makeSnapshot, activeWorkerCount } from "./status.js";
import { shellQuote, shortTaskLabel } from "./format.js";

const TEAM_NAME = /^[a-z][a-z0-9-]{0,22}$/;
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ROLES = new Set(["worker", "verifier", "lead"]);
const ACTIVE = new Set(["pending", "dispatched", "working", "blocked", "missing", "unknown"]);
const WAITABLE = new Set(["dispatched", "working", "blocked", "missing", "unknown"]);

function now() {
  return new Date().toISOString();
}

function taskIdFor(team, taskCard) {
  const digest = createHash("sha256").update(`${team}\0${taskCard}`).digest("hex").slice(0, 12);
  return `task_${digest}`;
}

function generatedName(role, team) {
  const prefix = { worker: "w", verifier: "v", lead: "l" }[role];
  return `${prefix}-${team}-${randomUUID().slice(0, 6)}`;
}

function normalizeTaskPath(cwd, value) {
  const withoutAt = value.startsWith("@") ? value.slice(1) : value;
  return resolve(cwd, withoutAt);
}

function assignmentFrom(registry, target) {
  return registry.assignments.find((assignment) => assignment.id === target || assignment.name === target);
}

export class Fleet {
  constructor({ cwd = process.cwd(), root, herdr, cliPath } = {}) {
    this.cwd = resolve(cwd);
    this.root = resolve(this.cwd, root ?? process.env.PI_FLEET_ROOT ?? ".pi/fleet");
    this.store = new RegistryStore(this.root);
    this.herdr = herdr ?? new HerdrClient({ cwd: this.cwd });
    this.cliPath = cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url));
  }

  statusCommand(team, watch = true) {
    const parts = [
      shellQuote(process.execPath),
      shellQuote(this.cliPath),
      "--root",
      shellQuote(this.root),
      "status",
    ];
    if (team) parts.push("--team", shellQuote(team));
    if (watch) parts.push("--watch");
    return parts.join(" ");
  }

  async init({ noUi = false } = {}) {
    await this.store.init();
    if (noUi) return makeSnapshot(await this.store.read());
    const existing = await this.store.read();
    if (existing.summary?.paneId) return makeSnapshot(existing);
    const current = await this.herdr.currentPane();
    const pane = await this.herdr.splitPane({ paneId: current.pane_id, cwd: this.cwd });
    const summary = {
      workspaceId: pane.workspace_id,
      tabId: pane.tab_id,
      paneId: pane.pane_id,
      ownsPane: true,
    };
    await this.store.update((registry) => {
      registry.summary = summary;
    });
    await this.herdr.renamePane(pane.pane_id, "fleet-summary");
    await this.herdr.runCommand(pane.pane_id, this.statusCommand());
    return makeSnapshot(await this.store.read());
  }

  async createTeam({ name, workerLimit = 5 }) {
    if (!TEAM_NAME.test(name)) {
      throw usageError("Team names require lowercase letters, numbers, and hyphens. The maximum length is 23.");
    }
    if (!Number.isSafeInteger(workerLimit) || workerLimit <= 0) {
      throw usageError("The worker limit must be a positive integer.");
    }
    const timestamp = now();
    await this.store.update((registry) => {
      if (registry.teams.some((team) => team.name === name)) {
        throw new FleetError(`Team ${name} already exists.`, "team_exists");
      }
      registry.teams.push({
        name,
        workerLimit,
        status: "active",
        workspaceId: null,
        tabId: null,
        summaryPaneId: null,
        ownsTab: false,
        createdAt: timestamp,
        error: null,
      });
    });
    return (await this.store.read()).teams.find((team) => team.name === name);
  }

  defaultPrompt({ role, team, taskCard }) {
    if (role === "lead") {
      return [
        `You are the lead for fleet team ${team}.`,
        `Use ${this.statusCommand(team, false)} to inspect assignments.`,
        "Coordinate routine supervision.",
        "Report blockers and completed assignments to the coordinator.",
      ].join(" ");
    }
    return `Read ${taskCard}. Your fleet role is ${role}. Follow the task card and stop when your assignment is complete.`;
  }

  async reserveAssignment(options) {
    const { team, role, name, taskCard, cwd, prompt } = options;
    const timestamp = now();
    return this.store.update((registry) => {
      const teamRecord = registry.teams.find((item) => item.name === team);
      if (!teamRecord || teamRecord.status !== "active") {
        throw new FleetError(`Team ${team} is not active.`, "team_not_active");
      }
      if (registry.assignments.some((assignment) => assignment.name === name && assignment.status !== "released")) {
        throw new FleetError(`Agent name ${name} is already assigned.`, "agent_name_exists");
      }
      if (role === "worker" && activeWorkerCount(registry, team) >= teamRecord.workerLimit) {
        throw new FleetError(`Team ${team} reached its worker limit.`, "worker_limit");
      }
      if (role === "lead" && registry.assignments.some((item) => item.team === team && item.role === "lead" && item.status !== "released")) {
        throw new FleetError(`Team ${team} already has a lead.`, "lead_exists");
      }
      const taskId = role === "lead" ? null : taskIdFor(team, taskCard);
      if (role !== "lead") {
        const duplicate = registry.assignments.some(
          (item) => item.taskId === taskId && item.role === role && item.status !== "released",
        );
        if (duplicate) {
          throw new FleetError(
            `This task already has a ${role}. Release the previous assignment before redispatch.`,
            "role_exists",
          );
        }
        if (
          role === "verifier" &&
          !registry.assignments.some(
            (item) => item.taskId === taskId && item.role === "worker" && item.status !== "released",
          )
        ) {
          throw new FleetError("Dispatch a worker before a verifier for this task.", "worker_required");
        }
      }
      let task = taskId ? registry.tasks.find((item) => item.id === taskId) : null;
      if (taskId && !task) {
        task = {
          id: taskId,
          team,
          taskCard,
          status: "open",
          workspaceId: null,
          tabId: null,
          commandPaneId: null,
          ownsTab: false,
          createdAt: timestamp,
        };
        registry.tasks.push(task);
      } else if (task) {
        task.status = "open";
      }
      const assignment = {
        id: `asg_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        name,
        team,
        role,
        taskId,
        taskCard,
        prompt,
        cwd,
        status: "pending",
        herdrState: "unknown",
        workspaceId: null,
        tabId: null,
        paneId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        releasedAt: null,
        error: null,
      };
      registry.assignments.push(assignment);
      return { assignment, task };
    });
  }

  async dispatch(options) {
    const role = options.role ?? "worker";
    if (!ROLES.has(role)) throw usageError("The role must be worker, verifier, or lead.");
    if (!options.team) throw usageError("Dispatch requires --team.");
    if (role !== "lead" && !options.task) throw usageError("Worker and verifier dispatch require --task.");
    const name = options.name ?? generatedName(role, options.team);
    if (!AGENT_NAME.test(name)) throw usageError("The agent name does not match Herdr naming rules.");
    const cwd = resolve(this.cwd, options.cwd ?? ".");
    const taskCard = options.task ? normalizeTaskPath(cwd, options.task) : null;
    if (taskCard) {
      try {
        await access(taskCard);
      } catch (error) {
        throw new FleetError(`The task card does not exist: ${taskCard}`, "task_not_found", { cause: error });
      }
    }
    const prompt =
      options.prompt?.replaceAll("{task}", taskCard ?? "").replaceAll("{role}", role).replaceAll("{team}", options.team) ??
      this.defaultPrompt({ role, team: options.team, taskCard });
    const leadSummary = role === "lead" ? (await this.store.read()).summary : null;
    if (role === "lead" && !leadSummary?.paneId) {
      throw new FleetError("The fleet has no summary pane. Run init without --no-ui.", "fleet_ui_missing");
    }
    const reserved = await this.reserveAssignment({
      ...options,
      role,
      name,
      cwd,
      taskCard,
      prompt,
    });
    const assignmentId = reserved.assignment.id;
    try {
      let pane;
      if (role === "lead") {
        pane = await this.herdr.splitPane({ paneId: leadSummary.paneId, cwd });
        await this.store.update((registry) => {
          const assignment = registry.assignments.find((item) => item.id === assignmentId);
          Object.assign(assignment, {
            workspaceId: pane.workspace_id,
            tabId: pane.tab_id,
            paneId: pane.pane_id,
          });
        });
      } else {
        const current = (await this.store.read()).tasks.find((task) => task.id === reserved.assignment.taskId);
        if (current.tabId) {
          const anchor = (await this.store.read()).assignments.find(
            (item) => item.taskId === current.id && item.paneId && item.status !== "released",
          );
          if (!anchor) throw new FleetError("The task tab has no available assignment pane.", "task_pane_missing");
          pane = await this.herdr.splitPane({ paneId: anchor.paneId, cwd });
        } else {
          const workspaceId = await this.herdr.workspaceId();
          const created = await this.herdr.createTab({
            workspaceId,
            cwd,
            label: shortTaskLabel(taskCard),
          });
          pane = created.rootPane;
          await this.store.update((registry) => {
            const task = registry.tasks.find((item) => item.id === current.id);
            Object.assign(task, {
              workspaceId,
              tabId: created.tab.tab_id,
              ownsTab: true,
            });
          });
        }
        await this.store.update((registry) => {
          const assignment = registry.assignments.find((item) => item.id === assignmentId);
          Object.assign(assignment, {
            workspaceId: pane.workspace_id,
            tabId: pane.tab_id,
            paneId: pane.pane_id,
          });
        });
        if (role === "verifier" && !current.commandPaneId) {
          const commandPane = await this.herdr.splitPane({ paneId: pane.pane_id, direction: "down", cwd });
          await this.herdr.renamePane(commandPane.pane_id, "commands");
          await this.store.update((registry) => {
            registry.tasks.find((item) => item.id === current.id).commandPaneId = commandPane.pane_id;
          });
        }
      }
      await this.herdr.startAgent({ name, paneId: pane.pane_id });
      await this.herdr.promptAgent({ name, prompt });
      await this.store.update((registry) => {
        const assignment = registry.assignments.find((item) => item.id === assignmentId);
        assignment.status = "dispatched";
        assignment.updatedAt = now();
      });
    } catch (error) {
      await this.store.update((registry) => {
        const assignment = registry.assignments.find((item) => item.id === assignmentId);
        assignment.status = "failed";
        assignment.error = error.message;
        assignment.updatedAt = now();
      });
      throw error;
    }
    return (await this.store.read()).assignments.find((assignment) => assignment.id === assignmentId);
  }

  async refresh() {
    const agents = await this.herdr.listAgents();
    const byName = new Map(agents.filter((agent) => agent.name).map((agent) => [agent.name, agent]));
    await this.store.update((registry) => {
      for (const assignment of registry.assignments) {
        const tracked = ACTIVE.has(assignment.status) || assignment.status === "settled";
        if (!tracked || assignment.status === "pending") continue;
        const agent = byName.get(assignment.name);
        if (!agent && assignment.status === "settled") continue;
        const previousStatus = assignment.status;
        const previousHerdrState = assignment.herdrState;
        const previousLocation = [assignment.workspaceId, assignment.tabId, assignment.paneId].join(":");
        if (!agent) {
          assignment.status = "missing";
          assignment.herdrState = "missing";
        } else {
          assignment.workspaceId = agent.workspace_id ?? assignment.workspaceId;
          assignment.tabId = agent.tab_id ?? assignment.tabId;
          assignment.paneId = agent.pane_id ?? assignment.paneId;
          const state = agent.agent_status ?? "unknown";
          assignment.herdrState = state;
          if (state === "working" || state === "blocked") assignment.status = state;
          else if (state === "idle" || state === "done") assignment.status = "settled";
          else assignment.status = "unknown";
          if (assignment.role === "worker" && assignment.taskId) {
            const task = registry.tasks.find((item) => item.id === assignment.taskId);
            if (task) {
              task.workspaceId = assignment.workspaceId;
              task.tabId = assignment.tabId;
            }
          }
        }
        const location = [assignment.workspaceId, assignment.tabId, assignment.paneId].join(":");
        if (assignment.status !== previousStatus || assignment.herdrState !== previousHerdrState || location !== previousLocation) {
          assignment.updatedAt = now();
        }
      }
    });
  }

  async status({ team, refresh = true } = {}) {
    if (refresh) await this.refresh();
    const registry = await this.store.read();
    if (team && !registry.teams.some((item) => item.name === team)) {
      throw new FleetError(`Team not found: ${team}`, "team_not_found");
    }
    return makeSnapshot(registry, team);
  }

  async release(target, { force = false } = {}) {
    await this.refresh();
    const registry = await this.store.read();
    const assignment = assignmentFrom(registry, target);
    if (!assignment) throw new FleetError(`Assignment not found: ${target}`, "assignment_not_found");
    if (assignment.status === "released") return assignment;
    if (ACTIVE.has(assignment.status) && !force) {
      throw new FleetError(
        `Assignment ${assignment.name} is ${assignment.status}. Use --force to release an active assignment.`,
        "assignment_active",
      );
    }
    const remaining = registry.assignments.filter(
      (item) => item.taskId === assignment.taskId && item.id !== assignment.id && item.status !== "released",
    );
    const task = assignment.taskId ? registry.tasks.find((item) => item.id === assignment.taskId) : null;
    if (task && remaining.length === 0 && task.ownsTab && task.tabId) {
      await this.herdr.closeTab(task.tabId);
    } else if (assignment.paneId) {
      await this.herdr.closePane(assignment.paneId);
    }
    await this.store.update((current) => {
      const record = current.assignments.find((item) => item.id === assignment.id);
      record.status = "released";
      record.releasedAt = now();
      record.updatedAt = record.releasedAt;
      if (task && remaining.length === 0) {
        current.tasks.find((item) => item.id === task.id).status = "released";
      }
    });
    return (await this.store.read()).assignments.find((item) => item.id === assignment.id);
  }

  async wait({ target, timeoutMs = 600_000, until = "settled" } = {}) {
    if (!new Set(["settled", "blocked"]).has(until)) throw usageError("The wait target must be settled or blocked.");
    const initial = await this.status();
    if (target && !initial.assignments.some((assignment) => assignment.id === target || assignment.name === target)) {
      throw new FleetError(`Assignment not found: ${target}`, "assignment_not_found");
    }
    const selected = initial.assignments.filter((assignment) => !target || assignment.id === target || assignment.name === target);
    const terminal = until === "blocked" ? new Set(["blocked"]) : new Set(["blocked", "settled", "failed", "missing"]);
    const ready = selected.find((assignment) => terminal.has(assignment.status));
    if (ready) return { status: "changed", assignment: ready };
    const candidates = selected.filter((assignment) => WAITABLE.has(assignment.status));
    if (candidates.length === 0) return { status: "empty", assignments: selected };
    const controller = new AbortController();
    const waits = candidates.map((assignment) =>
      this.herdr
        .waitAgent({
          name: assignment.name,
          timeoutMs,
          until: until === "blocked" ? "blocked" : undefined,
          signal: controller.signal,
        })
        .then(() => ({ assignment }))
        .catch((error) => ({ assignment, error })),
    );
    let outcome;
    try {
      outcome = await Promise.race(waits);
    } finally {
      controller.abort();
    }
    if (outcome.error) {
      if (outcome.error.code === "timeout") return { status: "timeout", assignment: outcome.assignment };
      throw outcome.error;
    }
    const snapshot = await this.status();
    return {
      status: "changed",
      assignment: snapshot.assignments.find((assignment) => assignment.id === outcome.assignment.id),
    };
  }

  async events() {
    return this.store.readEvents();
  }
}

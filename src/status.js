const ACTIVE_STATUSES = new Set(["pending", "dispatched", "working", "blocked", "missing", "unknown"]);

export function activeWorkerCount(registry, teamName) {
  return registry.assignments.filter(
    (assignment) =>
      assignment.team === teamName &&
      assignment.role === "worker" &&
      ACTIVE_STATUSES.has(assignment.status),
  ).length;
}

export function makeSnapshot(registry, teamName) {
  const teams = registry.teams.filter((team) => !teamName || team.name === teamName);
  const names = new Set(teams.map((team) => team.name));
  const assignments = registry.assignments.filter((assignment) => names.has(assignment.team));
  const taskIds = new Set(assignments.map((assignment) => assignment.taskId).filter(Boolean));
  return {
    updatedAt: registry.updatedAt,
    summary: registry.summary,
    teams: teams.map((team) => ({
      ...team,
      activeWorkers: activeWorkerCount(registry, team.name),
    })),
    tasks: registry.tasks.filter((task) => taskIds.has(task.id)),
    assignments,
  };
}

function statusCounts(assignments) {
  const counts = new Map();
  for (const assignment of assignments) {
    counts.set(assignment.status, (counts.get(assignment.status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(", ");
}

export function renderSnapshot(snapshot) {
  const activeAssignments = snapshot.assignments.filter((assignment) => ACTIVE_STATUSES.has(assignment.status)).length;
  const assignmentLabel = activeAssignments === 1 ? "assignment" : "assignments";
  const lines = [`Fleet: ${activeAssignments} active ${assignmentLabel}`, `Updated: ${snapshot.updatedAt}`, ""];
  if (snapshot.teams.length === 0) lines.push("No teams.");
  const history = [];
  for (const team of snapshot.teams) {
    const assignments = snapshot.assignments.filter((assignment) => assignment.team === team.name);
    const active = assignments.filter((assignment) => ACTIVE_STATUSES.has(assignment.status));
    const inactive = assignments.filter((assignment) => !ACTIVE_STATUSES.has(assignment.status));
    if (active.length > 0) {
      const assignmentLabel = active.length === 1 ? "assignment" : "assignments";
      lines.push(`${team.name}: ${active.length} active ${assignmentLabel} (${team.activeWorkers}/${team.workerLimit} workers)`);
      for (const assignment of active) {
        lines.push(`  ${assignment.status.toUpperCase()} ${assignment.role} ${assignment.name}`);
        if (assignment.taskCard) lines.push(`    ${assignment.taskCard.split("/").pop()}`);
      }
      lines.push("");
    }
    if (active.length === 0 || inactive.length > 0) {
      const counts = statusCounts(inactive);
      history.push(`  ${team.name}: ${counts || "no assignments"}`);
    }
  }
  if (snapshot.teams.length > 0 && activeAssignments === 0) lines.push("No active assignments.", "");
  if (history.length > 0) lines.push("History:", ...history, "");
  lines.push("Herdr settled states do not prove task completion.");
  return lines.join("\n");
}

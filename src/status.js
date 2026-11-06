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

export function renderSnapshot(snapshot) {
  const lines = [`Fleet updated: ${snapshot.updatedAt}`, ""];
  if (snapshot.teams.length === 0) lines.push("No teams.");
  for (const team of snapshot.teams) {
    lines.push(`Team ${team.name}: ${team.activeWorkers}/${team.workerLimit} active workers [${team.status}]`);
    const assignments = snapshot.assignments.filter((assignment) => assignment.team === team.name);
    if (assignments.length === 0) lines.push("  No assignments.");
    for (const assignment of assignments) {
      const task = assignment.taskCard ? ` ${assignment.taskCard}` : "";
      lines.push(`  ${assignment.name} ${assignment.role} ${assignment.status}${task}`);
    }
    lines.push("");
  }
  lines.push("Herdr settled states do not prove task completion.");
  return lines.join("\n");
}

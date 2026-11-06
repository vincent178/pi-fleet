---
name: fleet
description: Agent orchestrator for pi agents through Herdr. Use when coordinating multiple agents, dispatching tasks, checking assignment status, waiting for agent events, managing Herdr layouts, or fleet cleanup.
---

# Fleet coordination

Read the `herdr` skill before fleet operations. Herdr controls panes and agent
processes. The fleet core controls teams and assignments.

Run commands from the project root. The default registry path is `.pi/fleet`.
Run `pi-fleet help` for command syntax.

## Initialize

Run `pi-fleet init`. This command creates the registry and a fleet-summary pane
in the current tab.

Create a team before agent dispatch:

```bash
pi-fleet team create team-a --limit 5
```

This command creates one team tab with a status pane. Create at most five
active workers per team unless the operator selects another limit.

## Dispatch

Create a task card before worker dispatch. Send the task-card path to the
worker:

```bash
pi-fleet dispatch --team team-a --task .pi/tasks/<id>.md
```

Dispatch creates one task tab. The command returns after prompt delivery. It
does not wait for agent completion.

Dispatch a separate verifier for the same task:

```bash
pi-fleet dispatch --team team-a --task .pi/tasks/<id>.md --role verifier
```

The verifier uses the same task tab. The fleet core creates a command pane below
the verifier.

Use `--cwd` for an existing worktree. The fleet core does not create or remove
worktrees.

## Monitor

Use `pi-fleet status` for a fleet summary. Use `pi-fleet status --team team-a`
for one team.

Use `pi-fleet wait --assignment <id>` to wait for a settled or blocked agent.
Use `--until blocked` to wait only for blockage.

Herdr `idle` and `done` states become `settled` in the registry. These states
do not prove task completion. Use task artifacts and independent verification
as proof.

Inspect Herdr output before a prompt retry. Never resubmit a prompt blindly.

## Release

Release settled assignments after evidence recording:

```bash
pi-fleet release <assignment-id>
```

The release command closes only fleet-created panes and tabs. It does not
remove worktrees, branches, task cards, or registry events.

Active assignments require `--force`. Inspect the assignment before forced
release. The last assignment release closes the task tab.

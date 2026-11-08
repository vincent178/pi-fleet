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

This command creates a team record without a team tab. The fleet summary
shows active assignments and groups inactive assignments by status. Create at
most five active workers per team unless the operator selects another limit.

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
for one team. The watching summary reconciles existing assignments through
Herdr events. It uses a 30-second poll as a fallback.

The pi extension watches all registered assignment panes in the background. New
assignments join the watcher without an extension reload. Blocked, settled,
missing, failed, and unknown transitions send a follow-up message to the
coordinator. The message identifies the task card, assignment, role, and state.
It starts a turn when the coordinator is idle. It queues behind active work.

One coordinator can supervise several Over task loops through independent
assignments. Fleet reports Herdr states only. The Over workflow owns independent
verification, task completion, and task-card status.

Do not call `fleet wait` after every dispatch. Continue other work or respond to
the user. Use `pi-fleet wait --assignment <id>` for scripts or explicit
synchronous dependencies. Use `--until blocked` to wait only for blockage. This
command retains its blocking behavior.

Fleet uses explicit at-least-once delivery. A successful send precedes the
`delivery.json` record. An explicit send failure leaves the event pending. A
fresh coordinator runtime retries pending events. Handled event IDs prevent
resends after reconnects and completed reloads.

A failure can occur after a send but before persistence. A fresh runtime may
then duplicate the message. Pi `sendMessage()` has no idempotency key. Use
task-card state and Evidence for idempotent handling. Fleet does not claim
exactly-once delivery. Internal Fleet event messages use `display: false`.

One registry has one active assignment coordinator. Exclusive creation of
`coordinator.json` acquires the lease. Renewal keeps the lease active. A second
runtime cannot watch or deliver while that lease is active. Expiry permits
recovery after a crash. Every delivery checks ownership first.

The first watcher startup establishes a baseline. Existing history does not
wake the coordinator. Session shutdown closes watchers, stops renewal, and
releases the lease.

Herdr `idle` and `done` states become `settled` in the registry. These states
do not prove task completion. Use task artifacts and independent verification
as proof.

Inspect Herdr output before a prompt retry. If dispatch fails because a new
pane shell is not ready, inspect the pane. Confirm that Herdr did not send the
task prompt. Retry agent startup with a bounded delay. Never resubmit a prompt
blindly.

## Release

Release settled assignments after evidence recording:

```bash
pi-fleet release <assignment-id>
```

The release command closes only fleet-created panes and tabs. It does not
remove worktrees, branches, task cards, or registry events.

Active assignments require `--force`. Inspect the assignment before forced
release. The last assignment release closes the task tab.

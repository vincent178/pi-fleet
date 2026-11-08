# pi-fleet

**Coordinate teams of pi agents through Herdr.**

## Why use pi-fleet?

Multiple agents can work on independent tasks in parallel. Manual coordination
requires you to open panes, deliver prompts, track task ownership, monitor
agent states, and close panes after the work.

Pi-fleet gives one pi coordinator control of that work. Use it to:

- **Delegate without blocking.** Dispatch returns after prompt delivery. The
  coordinator can continue other work while agents run.
- **Keep tasks organized.** Each task has a dedicated tab for its worker and
  verifier. The fleet summary shows active assignments and inactive states.
- **Control capacity.** Team limits control the number of active workers.
  Assignment records prevent duplicate worker and verifier dispatches.
- **Monitor agent states.** Inspect all assignments in one view. The pi extension
  sends assignment transitions to the coordinator without a blocking wait.
- **Clean up safely.** Release closes only panes and tabs that pi-fleet created.

Pi-fleet coordinates agents, not task outcomes. A settled assignment does not
prove task completion. Your task workflow must define requirements, record
evidence, and verify completion.

The package contains a Node.js CLI and a pi extension. The CLI owns teams,
assignments, registry records, and Herdr layouts. The pi extension exposes
those operations through `/fleet` and the `fleet` tool.

## Requirements

- Node.js 22 or later
- Pi
- Herdr
- A Herdr-managed pane with `HERDR_ENV=1`

The CLI starts pi agents through Herdr.

## Install

Install the pi package from a local path:

```bash
pi install /path/to/pi-fleet
```

For CLI access during development, link the package:

```bash
cd /path/to/pi-fleet
npm link
```

For a load test without installation:

```bash
pi -ne -e /path/to/pi-fleet/extensions/index.ts
```

## Quick start

Initialize the registry and the coordinator layout:

```bash
pi-fleet init
```

Create a team with five worker slots:

```bash
pi-fleet team create team-a --limit 5
```

Dispatch a worker with a task card:

```bash
pi-fleet dispatch --team team-a --task .pi/tasks/task-example.md
```

Dispatch returns after prompt delivery. It does not wait for the worker.
The pi extension watches the new assignment in the background. It notifies the
coordinator when the assignment requires attention.

Inspect the fleet:

```bash
pi-fleet status
```

Wait for an agent to settle or block:

```bash
pi-fleet wait --assignment <assignment-id>
```

Dispatch an independent verifier for the same task:

```bash
pi-fleet dispatch --team team-a --task .pi/tasks/task-example.md --role verifier
```

Release settled assignments after evidence recording:

```bash
pi-fleet release <assignment-id>
```

## Herdr layout

Pi-fleet uses the current Herdr workspace. It does not create a workspace.

### Coordinator tab

`pi-fleet init` keeps the coordinator in the current pane. It adds a fleet
summary pane to the current tab. The summary subscribes to Herdr lifecycle
and agent-status events. It reconciles existing assignment IDs after each
event and after reconnects. A 30-second poll provides a fallback. Manual
panes and tabs do not become Fleet assignments.

### Team records

`pi-fleet team create` creates no Herdr UI. The fleet summary shows active
assignments with short task names. It groups inactive assignments by status.
A lead assignment splits the fleet summary pane.

### Task tab

The first worker dispatch creates one task tab. A verifier dispatch uses the
same task tab. The verifier receives a separate pane. Pi-fleet adds a command
pane below the verifier.

Pi-fleet preserves the operator's focus. It uses explicit Herdr IDs for later
operations. It closes only panes and tabs that it created.

## Commands

```text
pi-fleet [--root PATH] [--json] init [--no-ui]
pi-fleet [--root PATH] [--json] team create NAME [--limit N] [--no-ui]
pi-fleet [--root PATH] [--json] dispatch --team NAME [--task PATH] [options]
pi-fleet [--root PATH] [--json] status [--team NAME] [--watch] [--interval MS] [--no-refresh]
pi-fleet [--root PATH] [--json] wait [--assignment ID|NAME] [--until settled|blocked] [--timeout MS]
pi-fleet [--root PATH] [--json] release ID|NAME [--force]
pi-fleet [--root PATH] [--json] reconcile
pi-fleet [--root PATH] [--json] events [--limit N]
```

Global options precede the command. Run `pi-fleet help` for dispatch options.

The `--no-ui` option creates records without Herdr layout changes. Worker and
verifier dispatch still require Herdr panes.

## Pi extension

The extension supports the same operations through `/fleet`:

```text
/fleet init
/fleet team create team-a --limit 5
/fleet dispatch --team team-a --task .pi/tasks/task-example.md
/fleet status
/fleet wait --assignment <assignment-id>
/fleet release <assignment-id>
```

The `fleet` tool exposes these actions to the agent:

- `init`
- `team_create`
- `dispatch`
- `status`
- `wait`
- `release`
- `reconcile`

### Assignment notifications

The extension watches every registered assignment pane during the session. New
assignments join the watcher without an extension reload. Registry changes and
Herdr events trigger serialized reconciliation. The extension uses no polling
loop.

Blocked, settled, missing, failed, and unknown transitions produce a coordinator
message. Each message identifies the task card, assignment, role, and state
change. `pi.sendMessage()` starts a turn when the coordinator is idle. Follow-up
delivery queues the message behind active work.

One coordinator can supervise several Over task loops through independent
assignments. Fleet reports Herdr states only. The Over workflow owns independent
verification, task completion, and task-card status.

Fleet uses explicit at-least-once delivery. It records an event only after
`pi.sendMessage()` returns. An explicit send failure leaves the event pending.
A fresh coordinator runtime retries pending events. Registry event IDs and
`delivery.json` prevent resends after reconnects and completed reloads.

A failure can occur after a send but before `delivery.json` records the event.
A later reconciliation or reload may then duplicate that message. Pi
`sendMessage()` has no idempotency key. Fleet does not claim exactly-once
delivery. Each message tells Over to use task-card state and Evidence for
idempotent handling.

The extension creates an empty registry when needed. `pi-fleet init` still
creates the summary pane. The first watcher startup establishes a baseline.
Existing history does not wake the coordinator. Internal Fleet event messages
use `display: false`.

One registry has one active assignment coordinator. The coordinator acquires
`coordinator.json` through exclusive file creation. While that lease is active,
a second runtime cannot start watchers or deliver messages from that registry. The owner renews the
lease during its session. An expired lease permits recovery after a crash.
Every delivery checks ownership first. Session shutdown closes the socket and
file watcher, stops renewal, and releases the lease.

Use `fleet wait` when a script or the next coordinator action has a synchronous
dependency on an assignment state. The command keeps its blocking behavior.
Background notifications remove the need to wait after every dispatch.

## Registry

The default registry directory is `.pi/fleet`. Use `--root` or
`PI_FLEET_ROOT` to select another directory.

```text
.pi/fleet/
├── registry.json
├── events.jsonl
├── delivery.json
└── coordinator.json
```

`registry.json` stores teams, tasks, assignments, and Herdr IDs. `events.jsonl`
stores creation records and assignment state transitions with stable event IDs.
`delivery.json` stores handled event IDs for coordinator notifications.
`coordinator.json` stores the active coordinator lease and its expiry. Shutdown
removes the lease file. Stale recovery removes it after a crash.

`registry.lock` serializes registry writes and coordinator lease changes. The
lock record contains the owner PID, a unique owner token, and the creation time.
After 30 seconds, a contender checks the owner process. A live owner keeps the
lock beyond that threshold. A dead owner permits stale recovery. Concurrent
recovery uses `proper-lockfile` to serialize recovery and writer admission.
Owner-token checks prevent an old owner from removing a replacement lock.

Assignment states have these meanings:

| State | Meaning |
|---|---|
| `pending` | The fleet reserved the assignment |
| `dispatched` | Herdr accepted the prompt |
| `working` | Herdr reports active work |
| `blocked` | Herdr reports a question or approval request |
| `settled` | Herdr reports `idle` or `done` |
| `unknown` | Herdr cannot classify the agent state |
| `missing` | Herdr no longer lists the named agent |
| `failed` | A dispatch operation returned an error |
| `released` | The fleet released the assignment resources |

A settled assignment is not a completed task. Use independent verification and
task artifacts as completion proof.

## Teams and capacity

Each team has a worker limit. Pending, dispatched, working, blocked, missing,
and unknown workers consume capacity. Settled workers stop consuming capacity. A settled worker becomes active again
if Herdr reports new activity. A settled worker stays settled after its agent
exits.

Release a previous assignment before redispatch of the same role for that task.
This rule prevents duplicate workers and verifiers.

## Cleanup and safety

Release requires a settled, failed, or released assignment. Use `--force` for
an active assignment.

Each assignment release closes its current pane. The last assignment release
also closes the verifier command pane and the original Fleet-owned task tab
when they still exist. A manual destination tab is not closed.

Release checks Herdr again after closing the assignment pane. Release aborts
if a live agent moved during closure. The registry retains the new location.
Retry the release. A later move can still require manual pane cleanup.

Pi-fleet does not perform these operations:

- Merge branches
- Remove worktrees
- Remove task cards
- Change task-card status
- Verify task completion

Use `--cwd` to run an agent in an existing worktree.

## Architecture

```text
      Pi coordinator
            │
     /fleet or fleet tool
            │
            ▼
       Pi extension
            │
            ▼
        Fleet CLI
            │
            ▼
          Herdr
            │
            ▼
         Pi agents
```

The core uses Node.js built-ins and `proper-lockfile`. Atomic registry writes
and a registry lock support concurrent CLI commands.

## Development

```bash
npm test
npm run check
```

The tests use a fake Herdr client. They do not change the current Herdr
workspace.

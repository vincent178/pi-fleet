# pi-fleet

**pi-fleet manages teams of coding agents through Herdr.**

The package contains a standalone Node.js CLI and an optional pi extension.
The CLI owns teams, assignments, registry records, and Herdr layouts. The pi
extension exposes those operations through `/fleet` and the `fleet` tool.

Pi-fleet does not manage task requirements or completion. A task workflow such
as `over` retains those responsibilities.

## Requirements

- Node.js 22 or later
- Herdr
- A Herdr-managed pane with `HERDR_ENV=1`
- Pi for the optional extension

The CLI can manage every agent kind that Herdr supports. The agents do not need
to use pi.

## Install

Install the pi package from a local path:

```bash
pi install /path/to/pi-fleet
```

For standalone CLI development, link the package:

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
summary pane to the current tab.

### Team tab

`pi-fleet team create` creates one team tab. The tab contains a team status
pane. A lead assignment adds a lead pane to this tab.

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
pi-fleet [--root PATH] [--json] status [--team NAME] [--watch] [--no-refresh]
pi-fleet [--root PATH] [--json] wait [--assignment ID|NAME] [--until settled|blocked] [--timeout MS]
pi-fleet [--root PATH] [--json] release ID|NAME [--force]
pi-fleet [--root PATH] [--json] reconcile
pi-fleet [--root PATH] [--json] events [--limit N]
```

Global options precede the command. Run `pi-fleet help` for dispatch options.

The `--no-ui` option creates records without Herdr layout changes. Worker and
verifier dispatch still require Herdr panes.

## Pi adapter

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

## Registry

The default registry directory is `.pi/fleet`. Use `--root` or
`PI_FLEET_ROOT` to select another directory.

```text
.pi/fleet/
├── registry.json
└── events.jsonl
```

`registry.json` stores teams, tasks, assignments, and Herdr IDs. `events.jsonl`
stores creation records and assignment state transitions.

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
and unknown workers consume capacity. Settled workers stop consuming capacity.

Release a previous assignment before redispatch of the same role for that task.
This rule prevents duplicate workers and verifiers.

## Cleanup and safety

Release requires a settled, failed, or released assignment. Use `--force` for
an active assignment.

The last assignment release closes the task tab. Earlier releases close only
the assignment pane.

Pi-fleet does not perform these operations:

- Merge branches
- Remove worktrees
- Remove task cards
- Change task-card status
- Verify task completion

Use `--cwd` to run an agent in an existing worktree.

## Architecture

```text
over or another workflow
            │
            ▼
Optional pi adapter
            │
            ▼
Standalone fleet core
            │
            ▼
          Herdr
            │
            ▼
Herdr-supported coding agents
```

The core uses Node.js built-ins. It has no runtime npm dependencies. Atomic
registry writes and a registry lock support concurrent CLI commands.

## Development

```bash
npm test
npm run check
```

The tests use a fake Herdr client. They do not change the current Herdr
workspace.

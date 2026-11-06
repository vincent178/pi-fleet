#!/usr/bin/env node

import { parseArgs } from "node:util";
import { Fleet } from "./fleet.js";
import { extractGlobalOptions, positiveInteger } from "./args.js";
import { renderSnapshot } from "./status.js";
import { FleetError, messageOf } from "./errors.js";

const HELP = `pi-fleet manages agent teams through Herdr.

Usage:
  pi-fleet [--root PATH] [--json] init [--no-ui]
  pi-fleet [--root PATH] [--json] team create NAME [--limit N] [--no-ui]
  pi-fleet [--root PATH] [--json] dispatch --team NAME [--task PATH] [options]
  pi-fleet [--root PATH] [--json] status [--team NAME] [--watch] [--no-refresh]
  pi-fleet [--root PATH] [--json] wait [--assignment ID|NAME] [--until settled|blocked] [--timeout MS]
  pi-fleet [--root PATH] [--json] release ID|NAME [--force]
  pi-fleet [--root PATH] [--json] reconcile
  pi-fleet [--root PATH] [--json] events [--limit N]

Dispatch options:
  --role worker|verifier|lead  Default: worker
  --kind KIND                  Herdr agent kind. Default: pi
  --name NAME                  Agent name
  --cwd PATH                   Agent working directory
  --prompt TEXT                Custom prompt. Supports {task}, {role}, and {team}
`;

function options(args, definitions) {
  return parseArgs({ args, options: definitions, allowPositionals: true, strict: true });
}

function print(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function watchStatus(fleet, team, json, interval) {
  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
  });
  while (!stopped) {
    const snapshot = await fleet.status({ team });
    if (!json) process.stdout.write("\x1b[H\x1b[2J");
    print(json ? snapshot : renderSnapshot(snapshot), json);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export async function run(argv) {
  const global = extractGlobalOptions(argv);
  const [command, ...args] = global.rest;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    print(HELP, false);
    return;
  }
  const fleet = new Fleet({ root: global.root });

  if (command === "init") {
    const { values } = options(args, { "no-ui": { type: "boolean", default: false } });
    const snapshot = await fleet.init({ noUi: values["no-ui"] });
    print(global.json ? snapshot : "Fleet initialized.", global.json);
    return;
  }

  if (command === "team") {
    const [subcommand, ...teamArgs] = args;
    if (subcommand !== "create") throw new FleetError("Use team create NAME.", "usage_error");
    const { values, positionals } = options(teamArgs, {
      limit: { type: "string", default: "5" },
      "no-ui": { type: "boolean", default: false },
    });
    if (positionals.length !== 1) throw new FleetError("team create requires one name.", "usage_error");
    const team = await fleet.createTeam({
      name: positionals[0],
      workerLimit: positiveInteger(values.limit, "The worker limit"),
      noUi: values["no-ui"],
    });
    print(team, global.json);
    return;
  }

  if (command === "dispatch") {
    const { values, positionals } = options(args, {
      team: { type: "string" },
      task: { type: "string" },
      role: { type: "string", default: "worker" },
      kind: { type: "string", default: "pi" },
      name: { type: "string" },
      cwd: { type: "string" },
      prompt: { type: "string" },
    });
    if (positionals.length > 0) throw new FleetError("dispatch does not accept positional arguments.", "usage_error");
    const assignment = await fleet.dispatch(values);
    print(assignment, global.json);
    return;
  }

  if (command === "status") {
    const { values, positionals } = options(args, {
      team: { type: "string" },
      watch: { type: "boolean", default: false },
      interval: { type: "string", default: "2000" },
      "no-refresh": { type: "boolean", default: false },
    });
    if (positionals.length > 0) throw new FleetError("status does not accept positional arguments.", "usage_error");
    if (values.watch) {
      await watchStatus(fleet, values.team, global.json, positiveInteger(values.interval, "The interval"));
      return;
    }
    const snapshot = await fleet.status({ team: values.team, refresh: !values["no-refresh"] });
    print(global.json ? snapshot : renderSnapshot(snapshot), global.json);
    return;
  }

  if (command === "wait") {
    const { values, positionals } = options(args, {
      assignment: { type: "string" },
      until: { type: "string", default: "settled" },
      timeout: { type: "string", default: "600000" },
    });
    if (positionals.length > 0) throw new FleetError("wait does not accept positional arguments.", "usage_error");
    const result = await fleet.wait({
      target: values.assignment,
      until: values.until,
      timeoutMs: positiveInteger(values.timeout, "The timeout"),
    });
    print(result, global.json);
    return;
  }

  if (command === "release") {
    const { values, positionals } = options(args, { force: { type: "boolean", default: false } });
    if (positionals.length !== 1) throw new FleetError("release requires one assignment ID or agent name.", "usage_error");
    print(await fleet.release(positionals[0], { force: values.force }), global.json);
    return;
  }

  if (command === "reconcile") {
    print(await fleet.status(), global.json);
    return;
  }

  if (command === "events") {
    const { values, positionals } = options(args, { limit: { type: "string", default: "100" } });
    if (positionals.length > 0) throw new FleetError("events does not accept positional arguments.", "usage_error");
    const limit = positiveInteger(values.limit, "The event limit");
    const events = await fleet.events();
    print(events.slice(-limit), global.json);
    return;
  }

  throw new FleetError(`Unknown command: ${command}`, "usage_error");
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  const usage =
    (error instanceof FleetError && error.code === "usage_error") || error.code?.startsWith("ERR_PARSE_ARGS_");
  process.stderr.write(`pi-fleet: ${messageOf(error)}\n`);
  if (usage) process.stderr.write("Run pi-fleet help for usage.\n");
  process.exitCode = usage ? 2 : 1;
}

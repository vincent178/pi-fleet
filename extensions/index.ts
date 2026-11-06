import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitCommandLine } from "../src/args.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const OUTPUT_LIMIT = 50 * 1024;

interface FleetResult {
	code: number;
	stdout: string;
	stderr: string;
}

function outputText(result: FleetResult): string {
	let text = result.stdout || result.stderr || "The command produced no output.";
	if (Buffer.byteLength(text, "utf8") > OUTPUT_LIMIT) {
		text = `${text.slice(0, OUTPUT_LIMIT)}\n\nOutput truncated to ${OUTPUT_LIMIT} bytes.`;
	}
	return text;
}

function toolArguments(params: Record<string, unknown>): string[] {
	const action = params.action as string;
	const args: string[] = [];
	if (action === "team_create") {
		args.push("team", "create", String(params.name ?? ""));
		if (params.limit) args.push("--limit", String(params.limit));
		if (params.noUi) args.push("--no-ui");
		return args;
	}
	args.push(action);
	if (action === "status" && params.team) args.push("--team", String(params.team));
	if (action === "init" && params.noUi) args.push("--no-ui");
	if (action === "dispatch") {
		if (params.team) args.push("--team", String(params.team));
		if (params.task) args.push("--task", String(params.task));
		if (params.role) args.push("--role", String(params.role));
		if (params.name) args.push("--name", String(params.name));
		if (params.cwd) args.push("--cwd", String(params.cwd));
		if (params.prompt) args.push("--prompt", String(params.prompt));
	}
	if (action === "wait") {
		if (params.assignment) args.push("--assignment", String(params.assignment));
		if (params.until) args.push("--until", String(params.until));
		if (params.timeout) args.push("--timeout", String(params.timeout));
	}
	if (action === "release") {
		args.push(String(params.assignment ?? ""));
		if (params.force) args.push("--force");
	}
	return args;
}

export default function (pi: ExtensionAPI) {
	async function execute(args: string[], cwd: string, signal?: AbortSignal, json = false): Promise<FleetResult> {
		const root = join(cwd, CONFIG_DIR_NAME, "fleet");
		const globalArgs = [CLI_PATH, "--root", root];
		if (json) globalArgs.push("--json");
		return pi.exec(process.execPath, [...globalArgs, ...args], { cwd, signal });
	}

	pi.registerCommand("fleet", {
		description: "Manage agent teams, task assignments, Herdr layouts, and fleet resources",
		handler: async (source, ctx) => {
			try {
				const args = source.trim() ? splitCommandLine(source) : ["help"];
				const result = await execute(args, ctx.cwd);
				ctx.ui.notify(outputText(result), result.code === 0 ? "info" : "error");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "fleet",
		label: "Fleet",
		description:
			"Manage agent teams through Herdr. Dispatch agents without waiting. Herdr settled states do not prove task completion.",
		promptSnippet: "Manage agent teams, assignments, status, waits, and cleanup",
		promptGuidelines: [
			"Use fleet dispatch for nonblocking agent assignment.",
			"Use fleet status before releasing an assignment.",
			"Do not treat a settled Herdr agent as proof of task completion.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			action: StringEnum(["init", "team_create", "dispatch", "status", "wait", "release", "reconcile"] as const),
			team: Type.Optional(Type.String({ description: "Team name" })),
			name: Type.Optional(Type.String({ description: "Team name or agent name" })),
			task: Type.Optional(Type.String({ description: "Task-card path" })),
			role: Type.Optional(StringEnum(["worker", "verifier", "lead"] as const)),
			cwd: Type.Optional(Type.String({ description: "Agent working directory" })),
			prompt: Type.Optional(Type.String({ description: "Custom agent prompt" })),
			assignment: Type.Optional(Type.String({ description: "Assignment ID or agent name" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: "Team worker limit" })),
			timeout: Type.Optional(Type.Integer({ minimum: 1, description: "Wait timeout in milliseconds" })),
			until: Type.Optional(StringEnum(["settled", "blocked"] as const)),
			force: Type.Optional(Type.Boolean({ description: "Release an active assignment" })),
			noUi: Type.Optional(Type.Boolean({ description: "Create records without Herdr layout changes" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const args = toolArguments(params);
			const result = await execute(args, ctx.cwd, signal, true);
			return {
				content: [{ type: "text", text: outputText(result) }],
				details: result,
				isError: result.code !== 0,
			};
		},
	});
}

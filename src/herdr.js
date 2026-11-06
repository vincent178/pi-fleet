import { execFile } from "node:child_process";
import { FleetError } from "./errors.js";

function parseJson(source) {
  if (!source.trim()) return {};
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new FleetError("Herdr returned invalid JSON.", "herdr_invalid_json", { cause: error });
  }
}

function herdrError(error, stdout, stderr) {
  let payload;
  try {
    payload = JSON.parse(stderr || stdout);
  } catch {
    payload = undefined;
  }
  const remote = payload?.error;
  const code = remote?.code ?? (error.killed ? "process_timeout" : "command_failed");
  const message = remote?.message ?? error.message;
  return new FleetError(`Herdr: ${message}`, code, { cause: error });
}

export class HerdrClient {
  constructor({ cwd = process.cwd(), env = process.env, executable = "herdr" } = {}) {
    this.cwd = cwd;
    this.env = env;
    this.executable = executable;
  }

  assertEnvironment() {
    if (this.env.HERDR_ENV !== "1") {
      throw new FleetError(
        "Fleet operations require a Herdr-managed pane with HERDR_ENV=1.",
        "herdr_unavailable",
      );
    }
  }

  async run(args, { timeoutMs = 30_000, signal } = {}) {
    this.assertEnvironment();
    return new Promise((resolve, reject) => {
      execFile(
        this.executable,
        args,
        {
          cwd: this.cwd,
          env: this.env,
          timeout: timeoutMs,
          signal,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(herdrError(error, stdout, stderr));
            return;
          }
          try {
            resolve(parseJson(stdout));
          } catch (parseError) {
            reject(parseError);
          }
        },
      );
    });
  }

  async currentPane() {
    const response = await this.run(["pane", "current", "--current"]);
    return response.result.pane;
  }

  async workspaceId() {
    if (this.env.HERDR_WORKSPACE_ID) return this.env.HERDR_WORKSPACE_ID;
    const pane = await this.currentPane();
    return pane.workspace_id;
  }

  async createTab({ workspaceId, cwd, label }) {
    const response = await this.run([
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      cwd,
      "--label",
      label,
      "--no-focus",
    ]);
    return { tab: response.result.tab, rootPane: response.result.root_pane };
  }

  async splitPane({ paneId, direction = "right", cwd }) {
    const args = ["pane", "split", "--pane", paneId, "--direction", direction, "--no-focus"];
    if (cwd) args.push("--cwd", cwd);
    const response = await this.run(args);
    return response.result.pane;
  }

  async startAgent({ name, kind, paneId }) {
    await this.run(["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", "60000"], {
      timeoutMs: 65_000,
    });
  }

  async promptAgent({ name, prompt }) {
    await this.run(["agent", "prompt", name, prompt]);
  }

  async waitAgent({ name, timeoutMs, until, signal }) {
    const args = ["agent", "wait", name, "--timeout", String(timeoutMs)];
    if (until) args.push("--until", until);
    return this.run(args, { timeoutMs: timeoutMs + 5000, signal });
  }

  async listAgents() {
    const response = await this.run(["agent", "list"]);
    return response.result.agents;
  }

  async closePane(paneId) {
    await this.run(["pane", "close", paneId]);
  }

  async closeTab(tabId) {
    await this.run(["tab", "close", tabId]);
  }

  async swapPanes(sourcePaneId, targetPaneId) {
    await this.run(["pane", "swap", "--source-pane", sourcePaneId, "--target-pane", targetPaneId]);
  }

  async renamePane(paneId, label) {
    await this.run(["pane", "rename", paneId, label]);
  }

  async runCommand(paneId, command) {
    await this.run(["pane", "run", paneId, command]);
  }
}

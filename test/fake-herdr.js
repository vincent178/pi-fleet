export class FakeHerdr {
  constructor() {
    this.calls = [];
    this.panes = new Map();
    this.agents = new Map();
    this.prompts = [];
    this.commands = [];
    this.closedPanes = [];
    this.closedTabs = [];
    this.nextPane = 1;
    this.nextTab = 1;
    this.waitAction = null;
  }

  record(name, value) {
    this.calls.push({ name, value });
  }

  paneId() {
    return `w1:p${this.nextPane++}`;
  }

  async currentPane() {
    const pane = { pane_id: "w1:p0", tab_id: "w1:t0", workspace_id: "w1" };
    this.panes.set(pane.pane_id, pane);
    return pane;
  }

  async workspaceId() {
    return "w1";
  }

  async createTab({ workspaceId, cwd, label }) {
    const tab = { tab_id: `w1:t${this.nextTab++}`, workspace_id: workspaceId, label };
    const rootPane = {
      pane_id: this.paneId(),
      tab_id: tab.tab_id,
      workspace_id: workspaceId,
      cwd,
    };
    this.panes.set(rootPane.pane_id, rootPane);
    this.record("createTab", { tab, rootPane });
    return { tab, rootPane };
  }

  async splitPane({ paneId, direction = "right", cwd }) {
    const parent = this.panes.get(paneId);
    if (!parent) throw new Error(`Missing fake pane ${paneId}`);
    const pane = {
      pane_id: this.paneId(),
      tab_id: parent.tab_id,
      workspace_id: parent.workspace_id,
      cwd,
    };
    this.panes.set(pane.pane_id, pane);
    this.record("splitPane", { paneId, direction, pane });
    return pane;
  }

  async startAgent({ name, paneId }) {
    this.record("startAgent", { name, paneId });
    this.agents.set(name, { name, agent: "pi", agent_status: "idle", pane_id: paneId });
  }

  async promptAgent({ name, prompt }) {
    this.prompts.push({ name, prompt });
    this.agents.get(name).agent_status = "working";
  }

  async waitAgent({ name, until }) {
    this.record("waitAgent", { name, until });
    if (this.waitAction) await this.waitAction(name, this);
    return {};
  }

  async listAgents() {
    return [...this.agents.values()];
  }

  async closePane(paneId) {
    this.closedPanes.push(paneId);
    this.panes.delete(paneId);
    for (const [name, agent] of this.agents) {
      if (agent.pane_id === paneId) this.agents.delete(name);
    }
  }

  async closeTab(tabId) {
    this.closedTabs.push(tabId);
    for (const [paneId, pane] of this.panes) {
      if (pane.tab_id === tabId) this.panes.delete(paneId);
    }
    for (const [name, agent] of this.agents) {
      if (!this.panes.has(agent.pane_id)) this.agents.delete(name);
    }
  }

  async renamePane(paneId, label) {
    this.record("renamePane", { paneId, label });
  }

  async runCommand(paneId, command) {
    this.commands.push({ paneId, command });
  }
}

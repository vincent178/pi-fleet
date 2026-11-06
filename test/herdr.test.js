import test from "node:test";
import assert from "node:assert/strict";
import { HerdrClient } from "../src/herdr.js";
import { FleetError } from "../src/errors.js";

test("Herdr operations require a managed environment", async () => {
  const client = new HerdrClient({ env: {} });
  await assert.rejects(client.listAgents(), { code: "herdr_unavailable" });
});

test("close operations can ignore missing Herdr IDs", async () => {
  const client = new HerdrClient({ env: { HERDR_ENV: "1" } });
  client.run = async (args) => {
    const resource = args[0];
    throw new FleetError(`${resource} missing`, `${resource}_not_found`);
  };
  await client.closePane("w1:p1", { allowMissing: true });
  await client.closeTab("w1:t1", { allowMissing: true });
  await assert.rejects(client.closePane("w1:p1"), { code: "pane_not_found" });
  await assert.rejects(client.closeTab("w1:t1"), { code: "tab_not_found" });
});

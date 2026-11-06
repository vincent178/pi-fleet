import test from "node:test";
import assert from "node:assert/strict";
import { HerdrClient } from "../src/herdr.js";

test("Herdr operations require a managed environment", async () => {
  const client = new HerdrClient({ env: {} });
  await assert.rejects(client.listAgents(), { code: "herdr_unavailable" });
});

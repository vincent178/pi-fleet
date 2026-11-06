import test from "node:test";
import assert from "node:assert/strict";
import { renderSnapshot } from "../src/status.js";

test("summary prioritizes active assignments and compacts history", () => {
  const output = renderSnapshot({
    updatedAt: "2026-11-06T07:00:00Z",
    teams: [
      { name: "team-a", activeWorkers: 1, workerLimit: 4, status: "active" },
      { name: "team-b", activeWorkers: 0, workerLimit: 2, status: "active" },
      { name: "team-c", activeWorkers: 0, workerLimit: 2, status: "active" },
    ],
    assignments: [
      {
        team: "team-a",
        role: "worker",
        status: "working",
        name: "w-team-a",
        taskCard: "/long/path/to/task-one.md",
      },
      {
        team: "team-a",
        role: "verifier",
        status: "working",
        name: "v-team-a",
        taskCard: "/long/path/to/task-one.md",
      },
      {
        team: "team-a",
        role: "worker",
        status: "released",
        name: "w-old",
        taskCard: "/long/path/to/task-old.md",
      },
      {
        team: "team-b",
        role: "verifier",
        status: "settled",
        name: "v-team-b",
        taskCard: "/long/path/to/task-two.md",
      },
    ],
  });

  assert.match(output, /Fleet: 2 active assignments/);
  assert.match(output, /team-a: 2 active assignments\n/);
  assert.match(output, /WORKING worker w-team-a/);
  assert.match(output, /WORKING verifier v-team-a/);
  assert.match(output, /task-one\.md/);
  assert.doesNotMatch(output, /\/long\/path/);
  assert.doesNotMatch(output, /w-old/);
  assert.doesNotMatch(output, /v-team-b/);
  assert.match(output, /History:/);
  assert.match(output, /team-a: 1 released/);
  assert.match(output, /team-b: 1 settled/);
  assert.match(output, /team-c: no assignments/);
});

test("summary counts active verifiers without worker capacity", () => {
  const output = renderSnapshot({
    updatedAt: "2026-11-06T07:00:00Z",
    teams: [{ name: "repo-cleanup", activeWorkers: 0, workerLimit: 4, status: "active" }],
    assignments: [
      {
        team: "repo-cleanup",
        role: "verifier",
        status: "working",
        name: "web-lint-verifier-2",
        taskCard: "/long/path/to/task-web-lint.md",
      },
    ],
  });

  assert.match(output, /Fleet: 1 active assignment/);
  assert.match(output, /repo-cleanup: 1 active assignment\n/);
  assert.match(output, /WORKING verifier web-lint-verifier-2/);
  assert.doesNotMatch(output, /0 active workers/);
  assert.doesNotMatch(output, /worker slots|worker limit/);
});

test("summary handles no teams", () => {
  const output = renderSnapshot({ updatedAt: "2026-11-06T07:00:00Z", teams: [], assignments: [] });
  assert.match(output, /Fleet: 0 active assignments/);
  assert.match(output, /No teams\./);
  assert.match(output, /Herdr settled states do not prove task completion\./);
});

import test from "node:test";
import assert from "node:assert/strict";
import { splitCommandLine, extractGlobalOptions, positiveInteger } from "../src/args.js";
import { shellQuote } from "../src/format.js";

test("command-line splitting preserves quoted arguments", () => {
  assert.deepEqual(splitCommandLine(`dispatch --task "task one.md" --prompt 'read {task}'`), [
    "dispatch",
    "--task",
    "task one.md",
    "--prompt",
    "read {task}",
  ]);
});

test("command-line splitting rejects unclosed quotes", () => {
  assert.throws(() => splitCommandLine(`dispatch --task "task.md`), { code: "usage_error" });
});

test("global options precede the command and preserve later values", () => {
  assert.deepEqual(
    extractGlobalOptions(["--json", "--root", "/tmp/fleet", "dispatch", "--prompt", "--json"]),
    {
      root: "/tmp/fleet",
      json: true,
      rest: ["dispatch", "--prompt", "--json"],
    },
  );
});

test("positive integers reject invalid values", () => {
  assert.equal(positiveInteger("5", "Limit"), 5);
  assert.throws(() => positiveInteger("0", "Limit"), { code: "usage_error" });
  assert.throws(() => positiveInteger("1.5", "Limit"), { code: "usage_error" });
});

test("shell quoting preserves single quotes", () => {
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
});

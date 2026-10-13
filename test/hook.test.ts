import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Host } from "../src/host.ts";
import { fakeCheck, launches, task, tempRoot } from "./helpers.ts";

const hookScript = fileURLToPath(new URL("../src/hook.ts", import.meta.url));

function runHook(input: object): string {
  const out = spawnSync(process.execPath, [hookScript], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

test("the prompt hook gives open questions to both Copilot CLI and Claude Code", async (t) => {
  const cwd = await tempRoot(t);
  const host = new Host({ check: fakeCheck().check, env: {} });
  const text = await host.plan({ cwd, goal: "G", concurrency: 1, tasks: [task("a")] });
  const workflowId = launches(text)[0]!.workflowId;
  await host.report({
    cwd,
    workflowId,
    stepId: "a",
    attempt: 1,
    report: JSON.stringify({ status: "needs_user", summary: "", question: "Which branch?" }),
  });

  const out = JSON.parse(runHook({ cwd, session_id: `s-${Date.now()}`, prompt: "hi" }));
  assert.match(out.additionalContext, /step a \(Step a\): Which branch\?/);
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: "UserPromptSubmit", additionalContext: out.additionalContext });
});

test("the prompt hook prints nothing when a project has no workflows", async (t) => {
  const cwd = await tempRoot(t);
  assert.equal(runHook({ cwd, session_id: "s" }), "");
});

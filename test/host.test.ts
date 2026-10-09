import assert from "node:assert/strict";
import { test } from "node:test";
import { Host } from "../src/host.ts";
import { fakeCheck, launches, task, tempRoot } from "./helpers.ts";

const done = (summary: string) => `Finished.\n\`\`\`json\n${JSON.stringify({ status: "done", summary })}\n\`\`\``;

async function planned(t: Parameters<typeof tempRoot>[0], check = fakeCheck().check) {
  const cwd = await tempRoot(t);
  const host = new Host({ check });
  const text = await host.plan({
    cwd,
    goal: "Two things",
    concurrency: 2,
    tasks: [task("a"), task("b"), task("c", { dependsOn: ["a"] })],
  });
  const workflowId = /Created workflow (\S+)\./.exec(text)![1]!;
  return { cwd, host, text, workflowId };
}

test("dw_plan hands out ready steps up to the concurrency; reports hand out the next ones", async (t) => {
  const { cwd, host, text, workflowId } = await planned(t);
  assert.deepEqual(
    launches(text).map((l) => `${l.stepId}#${l.attempt}`),
    ["a#1", "b#1"],
  );
  assert.match(launches(text)[0]!.prompt, /\[running now\] b: Step b/);

  const again = await host.next({ cwd, workflowId });
  assert.deepEqual(launches(again), []);
  assert.match(again, /Waiting for the reports of: a \(attempt 1\), b \(attempt 1\)/);

  const afterA = await host.report({ cwd, workflowId, stepId: "a", attempt: 1, report: done("did a") });
  assert.match(afterA, /^Step "a" \(attempt 1\): done\./);
  assert.deepEqual(
    launches(afterA).map((l) => l.stepId),
    ["c"],
  );
  assert.match(launches(afterA)[0]!.prompt, /- a: Step a\n\s+did a/);
});

test("a stale attempt's report is ignored after dw_run requeues the step", async (t) => {
  const { cwd, host, workflowId } = await planned(t);
  const resumed = await host.run({ cwd, workflowId });
  assert.match(resumed, /Requeued 2 step\(s\)/);
  assert.deepEqual(
    launches(resumed).map((l) => `${l.stepId}#${l.attempt}`),
    ["a#2", "b#2"],
  );
  await assert.rejects(
    host.report({ cwd, workflowId, stepId: "a", attempt: 1, report: done("late") }),
    /attempt 1 is not running/,
  );
  assert.match(await host.report({ cwd, workflowId, stepId: "a", attempt: 2, report: done("ok") }), /done/);
});

test("checks gate completion and a report without JSON is retried", async (t) => {
  const checks = fakeCheck({ "npm test": [{ ok: false, output: "1 failing" }, { ok: true, output: "" }] });
  const cwd = await tempRoot(t);
  const host = new Host({ check: checks.check });
  const text = await host.plan({ cwd, goal: "G", concurrency: 1, tasks: [task("a", { check: "npm test" })] });
  const workflowId = launches(text)[0]!.workflowId;

  const failed = await host.report({ cwd, workflowId, stepId: "a", attempt: 1, report: done("x") });
  assert.match(failed, /not accepted; it runs again\.\nThe check failed:\n1 failing/);
  const noJson = await host.report({ cwd, workflowId, stepId: "a", attempt: 2, report: "All good!" });
  assert.match(noJson, /no JSON report/);
  const passed = await host.report({ cwd, workflowId, stepId: "a", attempt: 3, report: done("x") });
  assert.match(passed, /done, and its check passed/);
  assert.deepEqual(
    launches(passed).map((l) => l.stepId),
    ["goal"],
  );
  const finished = await host.report({ cwd, workflowId, stepId: "goal", attempt: 1, report: done("met") });
  assert.match(finished, /is done: all 2 steps finished/);
});

test("questions go to the user; answers can replace a check and are flagged", async (t) => {
  const { cwd, host, workflowId } = await planned(t);
  const asked = await host.report({
    cwd,
    workflowId,
    stepId: "b",
    attempt: 1,
    report: JSON.stringify({ status: "needs_user", summary: "", question: "Which branch?" }),
  });
  assert.match(asked, /step b \(Step b\): Which branch\?/);
  assert.match(asked, /Never answer for them/);
  assert.match(await host.status({ cwd, workflowId }), /1 step\(s\) wait for the user's answer/);

  const answered = await host.answer({ cwd, workflowId, nodeId: "b", answer: "main", check: "git branch" });
  assert.match(answered, /⚠ Step "b": .*check changed from none to `git branch`/);
  assert.deepEqual(
    launches(answered).map((l) => `${l.stepId}#${l.attempt}`),
    ["b#2"],
  );
});

test("tools need an absolute cwd; dw_status lists a project's workflows", async (t) => {
  const { cwd, host, workflowId } = await planned(t);
  await assert.rejects(host.status({ cwd: "relative" }), /absolute/);
  assert.match(await new Host().status({ cwd }), new RegExp(`- ${workflowId}: 2 step\\(s\\) handed out to subagents\\. Two things`));
  await assert.rejects(host.next({ cwd, workflowId: "nope" }), /no workflow "nope"/);
});

test("a slow check doesn't hold up other calls", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = async () => {
    await gate;
    return { ok: true, output: "" };
  };
  const cwd = await tempRoot(t);
  const host = new Host({ check: slow });
  const text = await host.plan({ cwd, goal: "G", concurrency: 2, tasks: [task("a", { check: "slow" }), task("b")] });
  const workflowId = launches(text)[0]!.workflowId;

  const reportA = host.report({ cwd, workflowId, stepId: "a", attempt: 1, report: done("a") });
  assert.match(await host.report({ cwd, workflowId, stepId: "b", attempt: 1, report: done("b") }), /"b".*done/);
  release();
  assert.match(await reportA, /done, and its check passed/);
});

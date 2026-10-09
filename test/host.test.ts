import assert from "node:assert/strict";
import { test } from "node:test";
import { Host } from "../src/host.ts";
import { fakeCheck, launches, task, tempRoot } from "./helpers.ts";

const done = (summary: string) => `Finished.\n\`\`\`json\n${JSON.stringify({ status: "done", summary })}\n\`\`\``;

async function planned(t: Parameters<typeof tempRoot>[0], check = fakeCheck().check) {
  const cwd = await tempRoot(t);
  const host = new Host({ check, env: {} });
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
  const host = new Host({ check: checks.check, env: {} });
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
  const host = new Host({ check: slow, env: {} });
  const text = await host.plan({ cwd, goal: "G", concurrency: 2, tasks: [task("a", { check: "slow" }), task("b")] });
  const workflowId = launches(text)[0]!.workflowId;

  const reportA = host.report({ cwd, workflowId, stepId: "a", attempt: 1, report: done("a") });
  assert.match(await host.report({ cwd, workflowId, stepId: "b", attempt: 1, report: done("b") }), /"b".*done/);
  release();
  assert.match(await reportA, /done, and its check passed/);
});

test("dw_view renders the graph colored by status, with questions, for a canvas", async (t) => {
  const { cwd, host, workflowId } = await planned(t);
  await host.report({ cwd, workflowId, stepId: "a", attempt: 1, report: done("did a") });
  const ask = `\`\`\`json\n${JSON.stringify({ status: "needs_user", summary: "stuck", question: 'Use "x" <or> y?' })}\n\`\`\``;
  await host.report({ cwd, workflowId, stepId: "b", attempt: 1, report: ask });

  const view = await host.view({ cwd, workflowId });
  assert.match(view, new RegExp(`^Show this with canvas_show: name "workflow-${workflowId}", title "Two things", kind "html"`));
  const html = view.slice(view.indexOf("<!doctype html>"));
  assert.match(html, /<script src="\/canvas-lib\/mermaid\.min\.js"><\/script>/);
  const mermaid = /<pre class="mermaid">([\s\S]*?)<\/pre>/.exec(html)![1]!;
  assert.match(mermaid, /n0\[&quot;&lt;b&gt;a&lt;\/b&gt;.*\]:::done/);
  assert.match(mermaid, /n1\[.*\]:::asking/);
  assert.match(mermaid, /n2\[.*\]:::running/);
  assert.match(mermaid, /n0 --&gt; n2/);
  assert.match(html, /<li><b>b<\/b>: Use &quot;x&quot; &lt;or&gt; y\?<\/li>/);
  assert.match(html, /1\/4 steps done/);
});

test("in an Agents session every state change drops the step graph into the canvas inbox", async (t) => {
  const { mkdtemp, readdir, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const inbox = await mkdtemp(join(tmpdir(), "dw-inbox-"));
  t.after(() => rm(inbox, { recursive: true, force: true }));
  const cwd = await tempRoot(t);
  const host = new Host({ check: fakeCheck().check, env: { AGENTS_CANVAS_INBOX: inbox, COPILOT_AGENT_SESSION_ID: "s1" } });
  const text = await host.plan({ cwd, goal: "Ship it", concurrency: 1, tasks: [task("a")] });
  const workflowId = /Created workflow (\S+)\./.exec(text)![1]!;
  await host.report({ cwd, workflowId, stepId: "a", attempt: 1, report: done("ok") });
  const files = (await readdir(inbox)).sort();
  assert.equal(files.length, 2);
  assert.ok(files.every((f) => f.endsWith(".json")));
  const last = JSON.parse(await readFile(join(inbox, files[1]!), "utf8"));
  assert.equal(last.sessionId, "s1");
  assert.equal(last.name, `workflow-${workflowId}`);
  assert.equal(last.kind, "html");
  assert.equal(last.title, "Ship it");
  assert.match(last.content, /flowchart TD/);
});

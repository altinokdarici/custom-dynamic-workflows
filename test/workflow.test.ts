import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runPass } from "../src/driver.ts";
import { InputError } from "../src/parse.ts";
import { loadWorkflowFiles, WORKFLOWS_DIR } from "../src/store.ts";
import type { TaskInput } from "../src/types.ts";
import { GOAL, Workflow } from "../src/workflow.ts";
import { fakeAgent, fakeCheck, task, tempRoot } from "./helpers.ts";

function create(root: string, tasks: TaskInput[], concurrency = 1, extra: { goalCheck?: string } = {}) {
  return Workflow.create(root, { goal: "Ship the thing", concurrency, tasks, ...extra });
}

const fail = (output: string) => ({ ok: false, output });
const pass = { ok: true, output: "" };

test("runs ready steps in parallel up to the concurrency, in dependency order", async (t) => {
  const root = await tempRoot(t);
  const wf = create(
    root,
    [task("a"), task("b"), task("c"), task("d", { dependsOn: ["a", { id: "b", label: "uses b's output" }] })],
    2,
  );
  const fake = fakeAgent();

  const result = await runPass(wf, { agent: fake.agent, check: fakeCheck().check });

  assert.deepEqual(result, { status: "done", workflowId: wf.id, steps: 5 });
  assert.equal(fake.maxRunning, 2);
  const order = fake.order();
  assert.ok(order.indexOf("d#1") > order.indexOf("a#1") && order.indexOf("d#1") > order.indexOf("b#1"));
  assert.equal(order.at(-1), "goal#1");
  const prompt = fake.calls.find((c) => c.id === "d")!.prompt;
  assert.match(prompt, /- b: Step b \(uses b's output\)\n\s+b finished/);
});

test("a failing check is retried with its output, then the step completes", async (t) => {
  const root = await tempRoot(t);
  const wf = create(root, [task("a", { check: "npm test" })]);
  const fake = fakeAgent();
  const checks = fakeCheck({ "npm test": [fail("1 failing: expected 3 to equal 4"), pass] });

  const result = await runPass(wf, { agent: fake.agent, check: checks.check });

  assert.equal(result.status, "done");
  assert.equal(wf.node("a").data.attempts, 2);
  assert.match(fake.calls[1]!.prompt, /The check failed:\n\s+1 failing: expected 3 to equal 4/);
  assert.deepEqual(
    checks.runs.map((r) => r.cwd),
    [root, root],
  );
});

test("the same failure twice asks the user; the answer reaches the next attempt", async (t) => {
  const root = await tempRoot(t);
  const wf = create(root, [task("a", { check: "lint", cwd: "pkg" })]);
  const fake = fakeAgent();
  // Only the line number differs, so the two failures count as the same.
  const checks = fakeCheck({ lint: [fail("error at line 12"), fail("error at line 13"), pass] });

  const first = await runPass(wf, { agent: fake.agent, check: checks.check });

  assert.equal(first.status, "waiting");
  assert.equal(first.status === "waiting" && first.questions[0]!.nodeId, "a");
  assert.match(wf.node("a").data.question!, /failed the same way twice/);
  assert.equal(checks.runs[0]!.cwd, join(root, "pkg"));

  wf.answer("a", "Disable that rule only for generated files.");
  const second = await runPass(wf, { agent: fake.agent, check: checks.check });

  assert.equal(second.status, "done");
  assert.match(fake.calls.at(-2)!.prompt, /Answer: Disable that rule only for generated files\./);
});

test("needs_user parks one step while the others finish", async (t) => {
  const root = await tempRoot(t);
  const wf = create(root, [task("a"), task("b")], 2);
  const fake = fakeAgent({
    a: [{ status: "needs_user", summary: "", question: "MIT or Apache-2.0?" }, { status: "done", summary: "MIT" }],
  });

  const first = await runPass(wf, { agent: fake.agent, check: fakeCheck().check });

  assert.equal(first.status, "waiting");
  assert.equal(wf.node("b").state, "completed");
  assert.equal(wf.node(GOAL).state, "pending");
  assert.throws(() => wf.answer("b", "x"), InputError);

  wf.answer("a", "MIT");
  const second = await runPass(wf, { agent: fake.agent, check: fakeCheck().check });
  assert.equal(second.status, "done");
  assert.match(fake.calls.find((c) => c.id === "a" && c.attempt === 2)!.prompt, /MIT or Apache-2.0\?\n\nAnswer: MIT/);
});

test("work found by a finished step runs before the steps that waited for it", async (t) => {
  const root = await tempRoot(t);
  const wf = create(root, [task("a"), task("b", { dependsOn: ["a"] })]);
  const fake = fakeAgent({
    a: [{ status: "done", summary: "done; README links are broken", newTasks: [task("fix-links")] }],
  });

  await runPass(wf, { agent: fake.agent, check: fakeCheck().check });

  assert.deepEqual(fake.order(), ["a#1", "fix-links#1", "b#1", "goal#1"]);
  assert.deepEqual(wf.graph.dependencyEdges("b"), [
    { id: "b", dependsOn: "a" },
    { id: "b", dependsOn: "fix-links", data: { label: "found by a" } },
  ]);
  assert.ok(wf.graph.dependenciesOf(GOAL).includes("fix-links"));
});

test("blocked runs the new prerequisites, then the step again", async (t) => {
  const root = await tempRoot(t);
  const wf = create(root, [task("a")]);
  const fake = fakeAgent({
    a: [{ status: "blocked", summary: "no worktree yet", newTasks: [task("Make Worktree")] }, undefined],
  });

  await runPass(wf, { agent: fake.agent, check: fakeCheck().check });

  assert.deepEqual(fake.order(), ["a#1", "make-worktree#1", "a#2", "goal#1"]);
  assert.deepEqual(wf.graph.dependencyEdges("a"), [
    { id: "a", dependsOn: "make-worktree", data: { label: "needed first" } },
  ]);
});

test("the goal check adds missing work and runs again", async (t) => {
  const root = await tempRoot(t);
  const wf = create(root, [task("a")], 1, { goalCheck: "npm run evals" });
  const fake = fakeAgent({
    goal: [{ status: "done", summary: "docs missing", newTasks: [task("docs")] }, undefined],
  });
  const checks = fakeCheck();

  const result = await runPass(wf, { agent: fake.agent, check: checks.check });

  assert.equal(result.status, "done");
  assert.deepEqual(fake.order(), ["a#1", "goal#1", "docs#1", "goal#2"]);
  // A goal report that still lists work is not "done", so its check only runs at the end.
  assert.deepEqual(
    checks.runs.map((r) => r.command),
    ["npm run evals"],
  );
});

test("the goal check asking for the same work twice asks the user instead of adding it again", async (t) => {
  const root = await tempRoot(t);
  const wf = create(root, [task("a")]);
  const fake = fakeAgent({
    goal: [
      { status: "done", summary: "docs missing", newTasks: [task("docs", { title: "Write  Docs" })] },
      { status: "done", summary: "still missing", newTasks: [task("docs-again", { title: "write docs " })] },
      undefined,
    ],
  });

  const first = await runPass(wf, { agent: fake.agent, check: fakeCheck().check });

  assert.equal(first.status, "waiting");
  assert.equal(first.status === "waiting" && first.questions[0]!.nodeId, GOAL);
  assert.match(wf.node(GOAL).data.question!, /same work twice/);
  assert.equal(wf.graph.has("docs-again"), false);
  assert.deepEqual(fake.order(), ["a#1", "goal#1", "docs#1", "goal#2"]);

  wf.answer(GOAL, "Skip the docs.");
  const second = await runPass(wf, { agent: fake.agent, check: fakeCheck().check });

  assert.equal(second.status, "done");
});

test("the goal check asking for different work each time keeps adding it", async (t) => {
  const root = await tempRoot(t);
  const wf = create(root, [task("a")]);
  const fake = fakeAgent({
    goal: [
      { status: "done", summary: "", newTasks: [task("x", { title: "X" })] },
      { status: "done", summary: "", newTasks: [task("y", { title: "Y" })] },
      { status: "done", summary: "", newTasks: [task("x2", { title: "X" })] },
      undefined,
    ],
  });

  const result = await runPass(wf, { agent: fake.agent, check: fakeCheck().check });

  assert.equal(result.status, "done");
  assert.deepEqual(fake.order(), ["a#1", "goal#1", "x#1", "goal#2", "y#1", "goal#3", "x2#1", "goal#4"]);
});

test("a report that would create a cycle is rejected without touching the graph", async (t) => {
  const root = await tempRoot(t);
  const wf = create(root, [task("a"), task("b", { dependsOn: ["a"] })]);
  const fake = fakeAgent({
    a: [{ status: "done", summary: "found x", newTasks: [task("x", { dependsOn: ["b"] })] }, undefined],
  });

  const result = await runPass(wf, { agent: fake.agent, check: fakeCheck().check });

  assert.equal(result.status, "done");
  assert.deepEqual(fake.order(), ["a#1", "a#2", "b#1", "goal#1"]);
  assert.equal(wf.graph.has("x"), false);
  assert.match(wf.node("a").data.lastError!, /could not be applied.*[Cc]ycle/);
});

test("failed asks the user right away; empty reports are retried, then asked", async (t) => {
  const root = await tempRoot(t);
  const wf = create(root, [task("a"), task("b")], 2);
  const fake = fakeAgent({ a: [{ status: "failed", summary: "No credentials for the registry." }], b: [null] });

  const result = await runPass(wf, { agent: fake.agent, check: fakeCheck().check });

  assert.equal(result.status, "waiting");
  assert.equal(wf.node("a").data.attempts, 1);
  assert.match(wf.node("a").data.question!, /No credentials/);
  assert.equal(wf.node("b").data.attempts, 2);
  assert.match(wf.node("b").data.question!, /without a report/);
});

test("steps left running by a crash are resumed from the saved file", async (t) => {
  const root = await tempRoot(t);
  const wf = create(root, [task("a"), task("b")]);
  wf.startNext();
  await wf.flush();

  const [file] = await loadWorkflowFiles(root, () => assert.fail());
  const reloaded = Workflow.load(root, file!.path, file!.doc);
  assert.equal(reloaded.node("a").state, "in-progress");
  const fake = fakeAgent();
  const result = await runPass(reloaded, { agent: fake.agent, check: fakeCheck().check });

  assert.equal(result.status, "done");
  assert.equal(reloaded.node("a").data.attempts, 2);
  assert.match(fake.calls.find((c) => c.id === "a")!.prompt, /did not succeed:\n\s+Interrupted before it reported/);
  await reloaded.flush();
  const saved = JSON.parse(await readFile(file!.path, "utf8"));
  assert.deepEqual(saved.graph, JSON.parse(JSON.stringify(reloaded.graph.toSnapshot())));
  assert.equal(saved.graph.nodes.every((n: { state: string }) => n.state === "completed"), true);
  assert.equal(await readFile(join(root, WORKFLOWS_DIR, ".gitignore"), "utf8"), "*\n");
});

test("bad plans are rejected before anything is saved", async (t) => {
  const root = await tempRoot(t);
  const bad: TaskInput[][] = [
    [task("a"), task("a")],
    [task("a", { dependsOn: ["nope"] })],
    [task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })],
    [task("goal")],
    [],
  ];
  for (const tasks of bad) assert.throws(() => create(root, tasks));
  assert.throws(() => create(root, [task("a")], 0), /concurrency/);
  assert.equal(existsSync(join(root, WORKFLOWS_DIR)), false);
});

test("added steps get unique ids and the goal waits for them", async (t) => {
  const root = await tempRoot(t);
  const wf = create(root, [task("a"), task("b")]);

  const ids = wf.addTasks([task("a"), task("c", { dependsOn: ["a"] })], ["b"]);

  assert.deepEqual(ids, ["a-2", "c"]);
  assert.deepEqual(wf.graph.dependenciesOf("c"), ["a-2"]);
  assert.deepEqual(wf.graph.dependenciesOf("b"), ["a-2", "c"]);
  assert.deepEqual(wf.graph.dependenciesOf(GOAL), ["a", "b", "a-2", "c"]);
  wf.startNext();
  assert.throws(() => wf.addTasks([task("d")], ["a"]), /in-progress/);
  await wf.flush();
});

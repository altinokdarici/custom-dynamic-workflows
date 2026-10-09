import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runCheck } from "../src/check.ts";
import { runPass } from "../src/driver.ts";
import { Host, isPaused } from "../src/host.ts";
import { workflowPath } from "../src/store.ts";
import { fakeAgent, fakeCheck, task, tempRoot } from "./helpers.ts";

function testHost(root: string, fake: ReturnType<typeof fakeAgent>) {
  const passes: string[] = [];
  const host: Host = new Host({
    root,
    startPass: (wf) => {
      passes.push(wf.id);
      return runPass(wf, { agent: fake.agent, check: fakeCheck().check, wake: host.wake(wf.id) });
    },
  });
  return { host, passes };
}

test("dw_plan runs in the background; dw_status waits; dw_answer resumes", async (t) => {
  const root = await tempRoot(t);
  const fake = fakeAgent({ b: [{ status: "needs_user", summary: "", question: "Which branch name?" }, undefined] });
  const { host } = testHost(root, fake);

  const started = await host.plan({ goal: "Do two things", concurrency: 2, tasks: [task("a"), task("b")] });
  const id = /Started workflow (\S+)\./.exec(started)![1]!;
  assert.match(await host.status({ workflowId: id }), /State: running/);

  const waiting = await host.status({ workflowId: id, wait: true });
  assert.match(waiting, /State: 1 step\(s\) wait for the user's answer/);
  assert.match(waiting, /\[waiting for user\] b: Step b\n\s+Question: Which branch name\?/);
  assert.deepEqual(
    host.questions().map((q) => q.nodeId),
    ["b"],
  );

  await host.answer({ workflowId: id, nodeId: "b", answer: "main" });
  assert.match(await host.status({ workflowId: id, wait: true }), /State: done/);
  assert.deepEqual(host.questions(), []);

  // A later session finds the workflow on disk.
  const later = new Host({ root, startPass: async () => undefined });
  assert.match(await later.status({}), new RegExp(`- ${id}: done\\. Do two things`));
});

test("steps added while a pass runs join that pass", async (t) => {
  const root = await tempRoot(t);
  const fake = fakeAgent({}, 30);
  const { host, passes } = testHost(root, fake);

  const started = await host.plan({ goal: "Grow", concurrency: 2, tasks: [task("a"), task("b", { dependsOn: ["a"] })] });
  const id = /Started workflow (\S+)\./.exec(started)![1]!;
  await host.addTask({ workflowId: id, task: task("c") });
  await assert.rejects(host.addTask({ workflowId: id, task: task("d"), blocks: ["a"] }), /in-progress/);
  await host.status({ workflowId: id, wait: true });

  assert.equal(passes.length, 1);
  assert.equal(fake.maxRunning, 2);
  assert.deepEqual(fake.order().sort(), ["a#1", "b#1", "c#1", "goal#1"]);
});

test("tool input errors explain what to fix", async (t) => {
  const root = await tempRoot(t);
  const { host } = testHost(root, fakeAgent());
  await assert.rejects(host.plan({ goal: "x", concurrency: 1, tasks: [{ id: "a", title: "A" }] }), /instructions/);
  await assert.rejects(host.run({ workflowId: "nope" }), /no workflow "nope"/);
  assert.equal(await host.status(undefined), `No workflows in ${root}.`);
});

test("runCheck reports the exit code and output of the command", async (t) => {
  const root = await tempRoot(t);
  assert.equal((await runCheck("echo fine", root)).ok, true);

  const failed = await runCheck("echo boom >&2; exit 3", root);
  assert.equal(failed.ok, false);
  assert.match(failed.output, /^\$ echo boom >&2; exit 3\nboom\n\(exit 3\)$/);

  const missing = await runCheck("true", join(root, "nope"));
  assert.deepEqual(missing, { ok: false, output: `The check directory does not exist: ${join(root, "nope")}` });

  const controller = new AbortController();
  const slow = runCheck("sleep 5", root, controller.signal);
  controller.abort();
  await assert.rejects(slow);
});

test("isPaused: only idle, unfinished workflows with startable steps", () => {
  assert.equal(isPaused({ running: false, complete: false, runnableWork: true }), true);
  assert.equal(isPaused({ running: true, complete: false, runnableWork: true }), false);
  assert.equal(isPaused({ running: false, complete: true, runnableWork: false }), false);
  assert.equal(isPaused({ running: false, complete: false, runnableWork: false }), false);
});

test("a later session lists paused workflows without resuming them", async (t) => {
  const root = await tempRoot(t);
  const first = new Host({ root, startPass: async () => undefined });
  const started = await first.plan({ goal: "Half", concurrency: 1, tasks: [task("a"), task("b", { dependsOn: ["a"] })] });
  const id = /Started workflow (\S+)\./.exec(started)![1]!;
  await first.status({ workflowId: id, wait: true });

  const passes: string[] = [];
  const later = new Host({ root, startPass: async (wf) => (passes.push(wf.id), undefined) });
  await later.load();
  assert.deepEqual(
    later.paused().map((wf) => wf.id),
    [id],
  );
  assert.deepEqual(passes, []);
});

test("a session reads a workflow another session changed and never runs it from an old copy", async (t) => {
  const root = await tempRoot(t);
  const fake = fakeAgent({ a: [{ status: "needs_user", summary: "", question: "Which one?" }, undefined] });
  const { host: first } = testHost(root, fake);
  const id = /Started workflow (\S+)\./.exec(await first.plan({ goal: "g", concurrency: 1, tasks: [task("a")] }))![1]!;
  await first.status({ workflowId: id, wait: true });

  const late = fakeAgent();
  const { host: second } = testHost(root, late);
  await second.load();
  assert.deepEqual(second.questions().map((q) => q.nodeId), ["a"]);

  await first.answer({ workflowId: id, nodeId: "a", answer: "this one" });
  assert.match(await first.status({ workflowId: id, wait: true }), /State: done/);

  assert.match(await second.status({ workflowId: id }), /State: done/);
  await second.load();
  assert.deepEqual(second.questions(), []);
  await assert.rejects(second.answer({ workflowId: id, nodeId: "a", answer: "stale" }), /not waiting for an answer/);
  assert.match(await second.run({ workflowId: id }), /Nothing to run/);
  assert.deepEqual(late.calls, [], "finished steps never run again from an old copy");
  const saved = JSON.parse(await readFile(workflowPath(root, id), "utf8")) as { graph: { nodes: { state: string }[] } };
  assert.ok(saved.graph.nodes.every((n) => n.state === "completed"), "the finished workflow on disk is untouched");
});

test("answers given at the same time are all kept, and the user sees each one", async (t) => {
  const root = await tempRoot(t);
  const ask = (q: string) => [{ status: "needs_user", summary: "", question: q }, (p: string) => ({ status: "done", summary: p.includes("answer-") ? "got it" : "no answer" })];
  const fake = fakeAgent({ a: ask("A?"), b: ask("B?") });
  const logs: { message: string; level?: string }[] = [];
  const host: Host = new Host({
    root,
    startPass: (wf) => runPass(wf, { agent: fake.agent, check: fakeCheck().check, wake: host.wake(wf.id) }),
    log: (message, level) => logs.push({ message, level }),
  });
  const id = /Started workflow (\S+)\./.exec(await host.plan({ goal: "g", concurrency: 2, tasks: [task("a"), task("b", { check: "bad" })] }))![1]!;
  await host.status({ workflowId: id, wait: true });
  assert.equal(host.questions().length, 2);

  await Promise.all([
    host.answer({ workflowId: id, nodeId: "a", answer: "answer-a" }),
    host.answer({ workflowId: id, nodeId: "b", answer: "answer-b", check: "good" }),
  ]);
  const status = await host.status({ workflowId: id, wait: true });
  assert.match(status, /State: done/);
  assert.equal((status.match(/got it/g) ?? []).length, 2, status);
  const changed = logs.find((l) => l.message.includes("check changed from `bad` to `good`"));
  assert.equal(changed?.level, "warning", JSON.stringify(logs));
  assert.ok(logs.some((l) => l.message.includes('answered "answer-a"')));
});

test("a workflow file that can't be loaded is skipped with one warning; the others still work", async (t) => {
  const root = await tempRoot(t);
  const warnings: string[] = [];
  const host = new Host({ root, startPass: async () => undefined, log: (m, level) => level === "warning" && warnings.push(m) });
  const id = /Started workflow (\S+)\./.exec(await host.plan({ goal: "Fine", concurrency: 1, tasks: [task("a")] }))![1]!;
  await host.status({ workflowId: id, wait: true });
  const broken = { version: 1, id: "broken", goal: "x", concurrency: 1, graph: { version: 1, nodes: [], dependencies: [{ id: "a", dependsOn: "b" }] } };
  await writeFile(join(root, ".copilot", "workflows", "broken.json"), JSON.stringify(broken));

  assert.match(await host.status({}), new RegExp(`- ${id}: paused`));
  assert.match(await host.status({}), new RegExp(`- ${id}: paused`));
  assert.equal(warnings.filter((w) => w.includes("broken.json")).length, 1, warnings.join("\n"));
});

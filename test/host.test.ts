import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { runCheck } from "../src/check.ts";
import { runPass } from "../src/driver.ts";
import { Host } from "../src/host.ts";
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

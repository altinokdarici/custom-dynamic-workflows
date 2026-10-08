import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runPass } from "../src/driver.ts";
import { Host } from "../src/host.ts";
import { acquireLock, isLockedByOther, lockPath, releaseLock } from "../src/lock.ts";
import { workflowPath } from "../src/store.ts";
import { fakeAgent, fakeCheck, task, tempRoot } from "./helpers.ts";

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
}

async function lockFile(t: Parameters<typeof tempRoot>[0]): Promise<string> {
  const root = await tempRoot(t);
  await mkdir(root, { recursive: true });
  return join(root, "wf.lock");
}

test("acquire is exclusive, re-entrant for this process, and released", async (t) => {
  const path = await lockFile(t);
  assert.equal(await acquireLock(path), undefined);
  assert.equal(await acquireLock(path), undefined);
  assert.equal(await isLockedByOther(path), false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { pid: process.pid, host: hostname() });
  releaseLock(path);
  assert.equal(await isLockedByOther(path), false);
  assert.equal(await readFile(path).catch(() => null), null);
});

test("a lock held by a live process is respected; a dead one is taken over", async (t) => {
  const path = await lockFile(t);
  await writeFile(path, JSON.stringify({ pid: process.ppid, host: hostname() }));
  assert.equal(await isLockedByOther(path), true);
  assert.equal((await acquireLock(path))?.owner?.pid, process.ppid);
  releaseLock(path);
  assert.equal(await isLockedByOther(path), true, "release must not remove another owner's lock");

  await writeFile(path, JSON.stringify({ pid: deadPid(), host: hostname() }));
  assert.equal(await isLockedByOther(path), false);
  assert.equal(await acquireLock(path), undefined);
  assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
});

test("a lock from another host or an unreadable lock counts as held", async (t) => {
  const path = await lockFile(t);
  await writeFile(path, JSON.stringify({ pid: deadPid(), host: "elsewhere" }));
  assert.equal(await isLockedByOther(path), true);
  await writeFile(path, "");
  assert.equal(await isLockedByOther(path), true);
});

test("tools refuse to run or change a workflow another process drives", async (t) => {
  const root = await tempRoot(t);
  const fake = fakeAgent();
  const host: Host = new Host({
    root,
    startPass: (wf) => runPass(wf, { agent: fake.agent, check: fakeCheck().check, wake: host.wake(wf.id) }),
  });
  const started = await host.plan({ goal: "g", concurrency: 1, tasks: [task("a")] });
  const id = /Started workflow (\S+)\./.exec(started)![1]!;
  assert.match(await host.status({ workflowId: id, wait: true }), /State: done/);
  assert.equal(await isLockedByOther(lockPath(workflowPath(root, id))), false, "lock released after the run");

  const other = new Host({ root, startPass: async () => undefined });
  await other.load();
  await writeFile(lockPath(workflowPath(root, id)), JSON.stringify({ pid: process.ppid, host: hostname() }));
  await other.addTask({ workflowId: id, task: task("b") }).then(
    () => assert.fail("expected refusal"),
    (e: Error) => assert.match(e.message, new RegExp(`process ${process.ppid} on`)),
  );
  assert.match(await other.run({ workflowId: id }), /Nothing to run|NOT resumed/);
  assert.match(await other.status({ workflowId: id }), /State: (done|running in process)/);
});

test("dw_run says when another process holds the lock", async (t) => {
  const root = await tempRoot(t);
  const fake = fakeAgent({ a: [{ status: "needs_user", summary: "", question: "q?" }] });
  const first: Host = new Host({
    root,
    startPass: (wf) => runPass(wf, { agent: fake.agent, check: fakeCheck().check, wake: first.wake(wf.id) }),
  });
  const id = /Started workflow (\S+)\./.exec(await first.plan({ goal: "g", concurrency: 1, tasks: [task("a")] }))![1]!;
  await first.status({ workflowId: id, wait: true });

  // Pretend a parent process drives it: the same file, a live foreign pid.
  await writeFile(lockPath(workflowPath(root, id)), JSON.stringify({ pid: process.ppid, host: hostname() }));
  const second = new Host({ root, startPass: async () => undefined });
  await second.answer({ workflowId: id, nodeId: "a", answer: "x" }).then(
    () => assert.fail("expected refusal"),
    (e: Error) => assert.match(e.message, /being driven by process \d+ on/),
  );
});

test("a process re-reads a workflow another process changed and never runs it from an old copy", async (t) => {
  const root = await tempRoot(t);
  const fake = fakeAgent({ a: [{ status: "needs_user", summary: "", question: "Which one?" }, undefined] });
  const first: Host = new Host({
    root,
    startPass: (wf) => runPass(wf, { agent: fake.agent, check: fakeCheck().check, wake: first.wake(wf.id) }),
  });
  const id = /Started workflow (\S+)\./.exec(await first.plan({ goal: "g", concurrency: 1, tasks: [task("a")] }))![1]!;
  await first.status({ workflowId: id, wait: true });

  const late = fakeAgent();
  const second: Host = new Host({
    root,
    startPass: (wf) => runPass(wf, { agent: late.agent, check: fakeCheck().check, wake: second.wake(wf.id) }),
  });
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
  assert.equal(await isLockedByOther(lockPath(workflowPath(root, id))), false);
});

test("answers given at the same time to a paused workflow are all kept", async (t) => {
  const root = await tempRoot(t);
  const ask = (q: string) => [{ status: "needs_user", summary: "", question: q }, (p: string) => ({ status: "done", summary: p.includes("answer-") ? "got it" : "no answer" })];
  const fake = fakeAgent({ a: ask("A?"), b: ask("B?") });
  const host: Host = new Host({
    root,
    startPass: (wf) => runPass(wf, { agent: fake.agent, check: fakeCheck().check, wake: host.wake(wf.id) }),
  });
  const id = /Started workflow (\S+)\./.exec(await host.plan({ goal: "g", concurrency: 2, tasks: [task("a"), task("b")] }))![1]!;
  await host.status({ workflowId: id, wait: true });
  assert.equal(host.questions().length, 2);

  await Promise.all([
    host.answer({ workflowId: id, nodeId: "a", answer: "answer-a" }),
    host.answer({ workflowId: id, nodeId: "b", answer: "answer-b" }),
  ]);
  const status = await host.status({ workflowId: id, wait: true });
  assert.match(status, /State: done/);
  assert.equal((status.match(/got it/g) ?? []).length, 2, status);
});

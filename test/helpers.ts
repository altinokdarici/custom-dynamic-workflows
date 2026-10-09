import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Host, type CheckFn } from "../src/host.ts";
import { loadWorkflowFiles } from "../src/store.ts";
import type { CheckResult, Question } from "../src/types.ts";
import { Workflow } from "../src/workflow.ts";

export async function tempRoot(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dw-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

type Reply = unknown | ((prompt: string) => unknown);

/**
 * A stand-in for ctx.agent. `script[id]` lists the reports for successive
 * attempts of a step; the last one repeats. Unscripted steps report done.
 */
export function fakeAgent(script: Record<string, Reply[]> = {}, delayMs = 5) {
  const calls: { id: string; attempt: number; prompt: string }[] = [];
  let running = 0;
  let maxRunning = 0;
  const agent = async (prompt: string, label: string): Promise<unknown> => {
    const [id = "", attempt = "0"] = label.split("#");
    calls.push({ id, attempt: Number(attempt), prompt });
    running++;
    maxRunning = Math.max(maxRunning, running);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const replies = script[id] ?? [];
      const reply = replies.length > 1 ? replies.shift() : replies[0];
      const value = typeof reply === "function" ? (reply as (p: string) => unknown)(prompt) : reply;
      return value === undefined ? { status: "done", summary: `${id} finished` } : value;
    } finally {
      running--;
    }
  };
  return {
    agent,
    calls,
    order: () => calls.map((c) => `${c.id}#${c.attempt}`),
    get maxRunning() {
      return maxRunning;
    },
  };
}

/** A stand-in for runCheck: `results[command]` lists results for successive runs; the last one repeats. */
export function fakeCheck(results: Record<string, CheckResult[]> = {}) {
  const runs: { command: string; cwd: string }[] = [];
  const check = async (command: string, cwd: string): Promise<CheckResult> => {
    runs.push({ command, cwd });
    const queue = results[command] ?? [];
    return (queue.length > 1 ? queue.shift() : queue[0]) ?? { ok: true, output: "" };
  };
  return { check, runs };
}

export function task(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: `Step ${id}`, instructions: `Do ${id}.`, ...extra };
}

/** One step the host handed out, parsed from its text the way the main agent reads it. */
export function launches(text: string): { workflowId: string; stepId: string; attempt: number; prompt: string }[] {
  const re = /### workflowId "([^"]+)", stepId "([^"]+)", attempt (\d+)\n<step-prompt>\n([\s\S]*?)\n<\/step-prompt>/g;
  return [...text.matchAll(re)].map((m) => ({ workflowId: m[1]!, stepId: m[2]!, attempt: Number(m[3]), prompt: m[4]! }));
}

export interface Simulated {
  status: "done" | "waiting" | "stuck";
  /** The workflow as saved after the run. */
  wf: Workflow;
  questions: Question[];
  answersAndCheckChanges: string[];
  /** The host's last reply. */
  text: string;
}

/**
 * Plays the main agent: resumes the workflow with dw_run, runs every launched
 * step with `agent` concurrently, reports each result with dw_report, and
 * launches what the replies hand out, until nothing is running.
 */
export async function runPass(
  wf: Workflow,
  options: { agent: (prompt: string, label: string) => Promise<unknown>; check: CheckFn; host?: Host },
): Promise<Simulated> {
  await wf.flush();
  const host = options.host ?? new Host({ check: options.check, env: {} });
  const cwd = wf.root;
  let text = await host.run({ cwd, workflowId: wf.id });
  const running = new Set<Promise<void>>();
  const start = (reply: string) => {
    text = reply;
    for (const l of launches(reply)) {
      const p: Promise<void> = options
        .agent(l.prompt, `${l.stepId}#${l.attempt}`)
        .then((report) => host.report({ cwd, workflowId: l.workflowId, stepId: l.stepId, attempt: l.attempt, report }))
        .then(start)
        .finally(() => running.delete(p));
      running.add(p);
    }
  };
  start(text);
  while (running.size) await Promise.race(running);
  const [file] = (await loadWorkflowFiles(cwd, () => {})).filter((f) => f.doc.id === wf.id);
  const saved = Workflow.load(cwd, file!.path, file!.doc);
  const questions = saved.questions();
  const status = saved.graph.isComplete ? "done" : questions.length ? "waiting" : "stuck";
  return { status, wf: saved, questions, answersAndCheckChanges: saved.changes(), text };
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { CheckResult } from "../src/types.ts";

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

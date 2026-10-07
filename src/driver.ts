import { InputError, parseOutcome } from "./parse.ts";
import { buildPrompt } from "./prompt.ts";
import type { CheckResult, PassResult, Question } from "./types.ts";
import type { Workflow } from "./workflow.ts";

/** Runs one step agent; resolves with its raw report (null when the agent failed). */
export type AgentFn = (prompt: string, label: string) => Promise<unknown>;
export type CheckFn = (command: string, cwd: string, signal: AbortSignal) => Promise<CheckResult>;

export interface PassOptions {
  agent: AgentFn;
  check: CheckFn;
  /** Notified when steps are added or answered while the pass runs. */
  wake?: Wake;
  signal?: AbortSignal;
  log?: (message: string) => void;
  onQuestion?: (question: Question) => void;
}

/** A promise that tools resolve to make a running pass look for new ready steps. */
export class Wake {
  #promise: Promise<void> | undefined;
  #resolve: (() => void) | undefined;

  wait(): Promise<void> {
    this.#promise ??= new Promise((resolve) => (this.#resolve = resolve));
    return this.#promise;
  }

  notify(): void {
    const resolve = this.#resolve;
    this.#promise = this.#resolve = undefined;
    resolve?.();
  }
}

/**
 * Runs ready steps, up to `concurrency` at a time, until nothing is ready or
 * running. Steps added mid-pass (by reports or tools) are picked up as they
 * become ready. Ends with every step done, or with the steps that wait for
 * the user. A hard agent error (cancellation, lost connection) stops new
 * dispatches and is rethrown once running steps settle.
 */
export async function runPass(wf: Workflow, options: PassOptions): Promise<PassResult> {
  const signal = options.signal ?? new AbortController().signal;
  const log = options.log ?? (() => {});
  const recovered = wf.recover();
  if (recovered) log(`Requeued ${recovered} interrupted step(s).`);

  const running = new Map<string, Promise<void>>();
  let failure: { error: unknown } | undefined;
  for (;;) {
    while (!failure && !signal.aborted && running.size < wf.concurrency) {
      const node = wf.startNext();
      if (!node) break;
      log(`▶ ${node.id} (attempt ${node.data.attempts})`);
      const step = runStep(wf, node.id, options, signal, log)
        .catch((error: unknown) => {
          failure ??= { error };
        })
        .finally(() => running.delete(node.id));
      running.set(node.id, step);
    }
    if (running.size === 0) break;
    await Promise.race([...running.values(), options.wake?.wait() ?? new Promise<void>(() => {})]);
  }

  await wf.flush();
  if (failure) throw failure.error;
  signal.throwIfAborted();
  return wf.passResult();
}

async function runStep(
  wf: Workflow,
  id: string,
  options: PassOptions,
  signal: AbortSignal,
  log: (message: string) => void,
): Promise<void> {
  const attempt = wf.node(id).data.attempts;
  const raw = await options.agent(buildPrompt(wf, id), `${id}#${attempt}`);

  let applied;
  try {
    const outcome = parseOutcome(raw);
    const command = wf.checkFor(id, outcome);
    const check = command === undefined ? undefined : await options.check(command, wf.cwdOf(id), signal);
    if (check) log(`${check.ok ? "✓" : "✗"} check for ${id}`);
    applied = wf.apply(id, outcome, check);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    applied = wf.retryOrAsk(id, error.message);
  }

  log(`${id}: ${applied}`);
  if (applied === "question") {
    const question = wf.questions().find((q) => q.nodeId === id);
    if (question) options.onQuestion?.(question);
  }
}

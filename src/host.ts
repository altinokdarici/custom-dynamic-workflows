import { execFileSync } from "node:child_process";
import { Wake } from "./driver.ts";
import { InputError, optionalText, parseTask, parseTasks, record, text } from "./parse.ts";
import { acquireLock, describeOwner, lockedByOther, lockPath, releaseLock, type LockOwner } from "./lock.ts";
import { loadWorkflowFiles, workflowPath } from "./store.ts";
import type { PassResult, Question } from "./types.ts";
import { Workflow } from "./workflow.ts";

export type LogLevel = "info" | "warning" | "error";

export interface HostOptions {
  /** Project root, or a function that finds it on first use. */
  root: string | (() => string);
  /**
   * Runs one pass over `wf` (in the extension: an SDK workflow run).
   * Resolves with the pass result, or undefined if the pass did not complete.
   */
  startPass(wf: Workflow): Promise<PassResult | undefined>;
  log?(message: string, level?: LogLevel): void;
}

type RunState = "started" | "running" | "idle" | "locked";

/**
 * Holds the workflows of one project and implements the dw_* tools.
 *
 * Several Copilot processes may share a project. A process changes or runs a
 * workflow only while it holds the workflow's lock, and re-reads the file
 * after taking it. A workflow it doesn't drive is re-read before every use,
 * so it never shows or acts on an old copy. Tool calls run one at a time, so
 * a re-read never replaces a workflow that another call is changing.
 */
export class Host {
  readonly #options: HostOptions;
  readonly #workflows = new Map<string, Workflow>();
  /** Workflows a pass of this process drives; this process holds their locks. */
  readonly #active = new Map<string, Promise<void>>();
  readonly #wakes = new Map<string, Wake>();
  /** Workflows whose lock another live process holds, with the owner when known. */
  readonly #foreign = new Map<string, LockOwner | undefined>();
  readonly #skipped = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();
  #root: string | undefined;

  constructor(options: HostOptions) {
    this.#options = options;
  }

  get root(): string {
    const { root } = this.#options;
    return (this.#root ??= typeof root === "function" ? root() : root);
  }

  /** Re-reads the project's workflow files, which other processes may have created or changed. They resume only when asked (dw_run). */
  load(): Promise<void> {
    return this.#serial(() => this.#load());
  }

  get(id: string): Workflow {
    const wf = this.#workflows.get(id);
    if (!wf) {
      const known = [...this.#workflows.keys()].join(", ") || "none";
      throw new InputError(`There is no workflow "${id}". Known workflows: ${known}.`);
    }
    return wf;
  }

  wake(id: string): Wake {
    let wake = this.#wakes.get(id);
    if (!wake) this.#wakes.set(id, (wake = new Wake()));
    return wake;
  }

  isRunning(id: string): boolean {
    return this.#active.has(id);
  }

  /** Workflows of this project that are paused with work left; one another live process drives is not paused. Call after load(). */
  paused(): Promise<Workflow[]> {
    return this.#serial(async () => {
      await this.#refreshLocks();
      return [...this.#workflows.values()].filter((wf) =>
        isPaused({
          running: this.#active.has(wf.id) || this.#foreign.has(wf.id),
          complete: wf.graph.isComplete,
          runnableWork: wf.hasRunnableWork(),
        }),
      );
    });
  }

  /** Open questions, except those of workflows another live process drives: they are answered there. Call after load(). */
  questions(): Question[] {
    return [...this.#workflows.values()].filter((wf) => !this.#foreign.has(wf.id)).flatMap((wf) => wf.questions());
  }

  /** Resolves when no pass of the workflow is running. */
  async idle(id: string, signal?: AbortSignal): Promise<void> {
    const active = this.#active.get(id);
    if (!active) return;
    if (!signal) return active;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      active.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  async plan(rawArgs: unknown): Promise<string> {
    const args = record(rawArgs, "arguments");
    const input = {
      goal: text(args.goal, "goal"),
      concurrency: args.concurrency as number,
      tasks: parseTasks(args.tasks),
      goalCheck: optionalText(args.goalCheck, "goalCheck"),
      goalCwd: optionalText(args.goalCwd, "goalCwd"),
    };
    return this.#serial(async () => {
      const created = Workflow.create(this.root, input);
      this.#workflows.set(created.id, created);
      await created.flush();
      const state = await this.#change(created.id);
      const lead =
        state === "locked"
          ? `Created workflow ${created.id}, but it is NOT running: ${this.#lockedText(created.id)}`
          : `Started workflow ${created.id}. It runs in the background; you get a notification when it finishes or needs the user.`;
      return [lead, this.#statusText(this.get(created.id))].join("\n\n");
    });
  }

  async run(rawArgs: unknown): Promise<string> {
    const args = record(rawArgs, "arguments");
    const id = text(args.workflowId, "workflowId");
    const { concurrency } = args;
    return this.#serial(async () => {
      const state = await this.#change(id, (wf) => {
        if (concurrency !== undefined && concurrency !== null) wf.concurrency = concurrency as number;
      });
      const lead = {
        started: "Resumed.",
        running: "Already running.",
        idle: "Nothing to run right now.",
        locked: `NOT resumed: ${this.#lockedText(id)}`,
      }[state];
      return `${lead}\n\n${this.#statusText(this.get(id))}`;
    });
  }

  async addTask(rawArgs: unknown): Promise<string> {
    const args = record(rawArgs, "arguments");
    const id = text(args.workflowId, "workflowId");
    const task = parseTask(args.task);
    const rawBlocks = args.blocks === undefined || args.blocks === null ? [] : args.blocks;
    if (!Array.isArray(rawBlocks)) throw new InputError("blocks must be an array of step ids.");
    const blocks = rawBlocks.map((b, i) => text(b, `blocks[${i}]`));
    return this.#serial(async () => {
      let added: string[] = [];
      const state = await this.#change(id, (wf) => {
        added = wf.addTasks([task], blocks);
      });
      if (state === "locked") throw new InputError(`Not changed: ${this.#lockedText(id)}`);
      return `Added step "${added[0]}" to workflow ${id}.`;
    });
  }

  async answer(rawArgs: unknown): Promise<string> {
    const args = record(rawArgs, "arguments");
    const id = text(args.workflowId, "workflowId");
    const nodeId = text(args.nodeId, "nodeId");
    const answer = text(args.answer, "answer");
    return this.#serial(async () => {
      const state = await this.#change(id, (wf) => wf.answer(nodeId, answer));
      if (state === "locked") throw new InputError(`Not changed: ${this.#lockedText(id)}`);
      return `Answered. Step "${nodeId}" of workflow ${id} runs again with the answer.`;
    });
  }

  async status(rawArgs: unknown, signal?: AbortSignal): Promise<string> {
    const args = rawArgs === undefined || rawArgs === null ? {} : record(rawArgs, "arguments");
    const id = optionalText(args.workflowId, "workflowId");
    if (!id) {
      return this.#serial(async () => {
        await this.#load();
        if (!this.#workflows.size) return `No workflows in ${this.root}.`;
        return [...this.#workflows.values()].map((wf) => `- ${wf.id}: ${this.#state(wf)}. ${wf.goal}`).join("\n");
      });
    }
    const wf = await this.#serial(async () => {
      await this.#load();
      return this.get(id);
    });
    if (args.wait === true) await this.idle(wf.id, signal);
    return this.#statusText(wf);
  }

  /**
   * Applies `change` to a workflow, then starts a pass for the work it leaves
   * or wakes the running one. When no pass of this process drives the
   * workflow, it first takes the lock and re-reads the file, since another
   * process may have changed it. Changes nothing and returns "locked" while
   * another live process holds the lock.
   */
  async #change(id: string, change: (wf: Workflow) => void = () => {}): Promise<RunState> {
    await this.#load();
    let wf = this.get(id);
    if (this.#active.has(id)) {
      change(wf);
      this.wake(id).notify();
      await wf.flush();
      return "running";
    }
    const lock = lockPath(workflowPath(this.root, id));
    const other = await acquireLock(lock);
    if (other) {
      this.#foreign.set(id, other.owner);
      return "locked";
    }
    this.#foreign.delete(id);
    try {
      await this.#load();
      wf = this.get(id);
      change(wf);
      await wf.flush();
    } catch (error) {
      releaseLock(lock);
      throw error;
    }
    if (!wf.hasRunnableWork()) {
      releaseLock(lock);
      return "idle";
    }
    const loop = this.#drive(wf).finally(() => {
      // Synchronous with the end of the pass, so no tool call finds a finished pass still running and only wakes it.
      this.#active.delete(id);
      releaseLock(lock);
    });
    this.#active.set(id, loop);
    return "started";
  }

  /** Re-reads the workflow files. A workflow a pass of this process drives is current in memory and kept. */
  async #load(): Promise<void> {
    const skip = (path: string, error: unknown) => {
      if (this.#skipped.has(path)) return;
      this.#skipped.add(path);
      this.#log(`Skipping ${path}: ${(error as Error).message}`, "warning");
    };
    const files = await loadWorkflowFiles(this.root, skip);
    const found = new Set<string>();
    for (const { path, doc } of files) {
      if (this.#active.has(doc.id)) {
        found.add(doc.id);
        continue;
      }
      try {
        this.#workflows.set(doc.id, Workflow.load(this.root, path, doc));
        found.add(doc.id);
      } catch (error) {
        skip(path, error);
      }
    }
    for (const id of this.#workflows.keys()) {
      if (!found.has(id) && !this.#active.has(id)) this.#workflows.delete(id);
    }
    await this.#refreshLocks();
  }

  async #refreshLocks(): Promise<void> {
    for (const wf of this.#workflows.values()) {
      const other = this.#active.has(wf.id) ? undefined : await lockedByOther(lockPath(workflowPath(this.root, wf.id)));
      if (other) this.#foreign.set(wf.id, other.owner);
      else this.#foreign.delete(wf.id);
    }
  }

  #lockedText(id: string): string {
    return `workflow ${id} is being driven by ${describeOwner(this.#foreign.get(id))}. Only one Copilot process may run or change a workflow at a time; wait for that run to end, or stop that process. A lock left by a dead process on this machine is taken over automatically; one left on another machine, or one that can't be read, has to be deleted by hand: ${lockPath(workflowPath(this.root, id))}`;
  }

  /** Runs tool calls one at a time, so a re-read never replaces a workflow that another call is changing. */
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => {});
    return result;
  }

  /** Runs passes until one ends with nothing left to start. Never rejects. */
  async #drive(wf: Workflow): Promise<void> {
    try {
      // Work added just as a pass finished is picked up by another pass.
      do {
        const result = await this.#options.startPass(wf);
        if (!result) return;
        if (result.status === "done") this.#log(`Workflow ${wf.id} is done.`);
      } while (wf.hasRunnableWork());
    } catch (error) {
      this.#log(`Workflow ${wf.id} stopped: ${(error as Error)?.message ?? String(error)}`, "error");
    }
  }

  #state(wf: Workflow): string {
    const questions = wf.questions().length;
    const asking = questions ? `${questions} step(s) wait for the user's answer (dw_answer)` : "";
    if (this.#active.has(wf.id)) return asking ? `running; ${asking}` : "running";
    if (this.#foreign.has(wf.id)) return `running in ${describeOwner(this.#foreign.get(wf.id))}`;
    if (wf.graph.isComplete) return "done";
    if (asking) return asking;
    return wf.hasRunnableWork() ? "paused (dw_run resumes it)" : "idle";
  }

  #statusText(wf: Workflow): string {
    return `State: ${this.#state(wf)}\n${wf.statusText()}`;
  }

  #log(message: string, level: LogLevel = "info"): void {
    this.#options.log?.(message, level);
  }
}

/** A workflow is paused when nothing runs it, it is not finished, and steps can still start. */
export function isPaused(state: { running: boolean; complete: boolean; runnableWork: boolean }): boolean {
  return !state.running && !state.complete && state.runnableWork;
}

/** The git top-level of `cwd`, or `cwd` outside a repository. */
export function projectRoot(cwd: string): string {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return top || cwd;
  } catch {
    return cwd;
  }
}

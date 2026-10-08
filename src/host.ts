import { execFileSync } from "node:child_process";
import { Wake } from "./driver.ts";
import { InputError, optionalText, parseTask, parseTasks, record, text } from "./parse.ts";
import { loadWorkflowFiles } from "./store.ts";
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

/** Holds the workflows of one project and implements the dw_* tools. */
export class Host {
  readonly #options: HostOptions;
  readonly #workflows = new Map<string, Workflow>();
  readonly #active = new Map<string, Promise<void>>();
  readonly #wakes = new Map<string, Wake>();
  #root: string | undefined;
  #loading: Promise<void> | undefined;

  constructor(options: HostOptions) {
    this.#options = options;
  }

  get root(): string {
    const { root } = this.#options;
    return (this.#root ??= typeof root === "function" ? root() : root);
  }

  /** Loads workflows saved by earlier sessions. They resume only when asked (dw_run). */
  load(): Promise<void> {
    return (this.#loading ??= (async () => {
      const files = await loadWorkflowFiles(this.root, (path, error) =>
        this.#log(`Skipping ${path}: ${(error as Error).message}`, "warning"),
      );
      for (const { path, doc } of files) {
        if (!this.#workflows.has(doc.id)) this.#workflows.set(doc.id, Workflow.load(this.root, path, doc));
      }
    })());
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

  /** Workflows of this project that are paused with work left. Call after load(). */
  paused(): Workflow[] {
    return [...this.#workflows.values()].filter((wf) =>
      isPaused({ running: this.#active.has(wf.id), complete: wf.graph.isComplete, runnableWork: wf.hasRunnableWork() }),
    );
  }

  questions(): Question[] {
    return [...this.#workflows.values()].flatMap((wf) => wf.questions());
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
    await this.load();
    const args = record(rawArgs, "arguments");
    const wf = Workflow.create(this.root, {
      goal: text(args.goal, "goal"),
      concurrency: args.concurrency as number,
      tasks: parseTasks(args.tasks),
      goalCheck: optionalText(args.goalCheck, "goalCheck"),
      goalCwd: optionalText(args.goalCwd, "goalCwd"),
    });
    this.#workflows.set(wf.id, wf);
    await wf.flush();
    this.#ensureRunning(wf);
    return [
      `Started workflow ${wf.id}. It runs in the background; you get a notification when it finishes or needs the user.`,
      this.#statusText(wf),
    ].join("\n\n");
  }

  async run(rawArgs: unknown): Promise<string> {
    await this.load();
    const args = record(rawArgs, "arguments");
    const wf = this.get(text(args.workflowId, "workflowId"));
    if (args.concurrency !== undefined && args.concurrency !== null) wf.concurrency = args.concurrency as number;
    await wf.flush();
    const state = this.#ensureRunning(wf);
    const lead = {
      started: "Resumed.",
      running: "Already running.",
      idle: "Nothing to run right now.",
    }[state];
    return `${lead}\n\n${this.#statusText(wf)}`;
  }

  async addTask(rawArgs: unknown): Promise<string> {
    await this.load();
    const args = record(rawArgs, "arguments");
    const wf = this.get(text(args.workflowId, "workflowId"));
    const blocks = args.blocks === undefined || args.blocks === null ? [] : args.blocks;
    if (!Array.isArray(blocks)) throw new InputError("blocks must be an array of step ids.");
    const [id] = wf.addTasks(
      [parseTask(args.task)],
      blocks.map((b, i) => text(b, `blocks[${i}]`)),
    );
    await wf.flush();
    this.#ensureRunning(wf);
    return `Added step "${id}" to workflow ${wf.id}.`;
  }

  async answer(rawArgs: unknown): Promise<string> {
    await this.load();
    const args = record(rawArgs, "arguments");
    const wf = this.get(text(args.workflowId, "workflowId"));
    const nodeId = text(args.nodeId, "nodeId");
    wf.answer(nodeId, text(args.answer, "answer"));
    await wf.flush();
    this.#ensureRunning(wf);
    return `Answered. Step "${nodeId}" of workflow ${wf.id} runs again with the answer.`;
  }

  async status(rawArgs: unknown, signal?: AbortSignal): Promise<string> {
    await this.load();
    const args = rawArgs === undefined || rawArgs === null ? {} : record(rawArgs, "arguments");
    const id = optionalText(args.workflowId, "workflowId");
    if (!id) {
      if (!this.#workflows.size) return `No workflows in ${this.root}.`;
      return [...this.#workflows.values()].map((wf) => `- ${wf.id}: ${this.#state(wf)}. ${wf.goal}`).join("\n");
    }
    const wf = this.get(id);
    if (args.wait === true) await this.idle(wf.id, signal);
    return this.#statusText(wf);
  }

  /** Starts a pass if none is running and there is work, or wakes the running pass. */
  #ensureRunning(wf: Workflow): "started" | "running" | "idle" {
    if (this.#active.has(wf.id)) {
      this.wake(wf.id).notify();
      return "running";
    }
    if (!wf.hasRunnableWork()) return "idle";
    const loop = this.#drive(wf);
    this.#active.set(wf.id, loop);
    void loop.finally(() => {
      if (this.#active.get(wf.id) === loop) this.#active.delete(wf.id);
    });
    return "started";
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

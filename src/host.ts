import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { INBOX_ENV, publishCanvas } from "./canvas.ts";
import { runCheck } from "./check.ts";
import { InputError, optionalText, parseOutcome, parseTask, parseTasks, record, text } from "./parse.ts";
import { buildPrompt } from "./prompt.ts";
import { loadWorkflowFiles } from "./store.ts";
import type { CheckResult, Outcome, Question } from "./types.ts";
import { viewHtml } from "./view.ts";
import { Workflow, type Applied } from "./workflow.ts";

export type CheckFn = (command: string, root: string) => Promise<CheckResult>;

export interface HostOptions {
  /** Runs a step's check from the project root. Defaults to runCheck. */
  check?: CheckFn;
  /** Environment that says where to show the workflow canvas. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** A step handed out to the main agent to run as a subagent. */
export interface Launch {
  stepId: string;
  attempt: number;
  prompt: string;
}

const LAUNCH = `Launch each step below now as its own background \`task\` subagent (agent_type "general-purpose"), passing the text inside <step-prompt> exactly as written. Do not do the steps yourself. When a subagent finishes, call dw_report with the workflowId, its stepId and attempt, and the subagent's final message.`;
const ASK = `Ask the user each question (with the ask_user tool if you have it) and pass their answer to dw_answer. Never answer for them. If you can see the cause, such as a wrong check, tell the user what you found and propose the fix.`;

/**
 * Implements the dw_* tools. Every call reads the workflow from disk and
 * writes it back before returning, so any session (and any number of
 * sessions) can drive a workflow. Calls for one project run one at a time;
 * checks run in between, so a slow check doesn't hold up other reports.
 */
export class Host {
  readonly #check: CheckFn;
  readonly #env: NodeJS.ProcessEnv;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: HostOptions = {}) {
    this.#check = options.check ?? runCheck;
    this.#env = options.env ?? process.env;
  }

  async plan(rawArgs: unknown): Promise<string> {
    const args = record(rawArgs, "arguments");
    const root = rootOf(args.cwd);
    const input = {
      goal: text(args.goal, "goal"),
      concurrency: args.concurrency as number,
      tasks: parseTasks(args.tasks),
      goalCheck: optionalText(args.goalCheck, "goalCheck"),
    };
    return this.#serial(root, async () => {
      const wf = Workflow.create(root, input);
      const shown = this.#env[INBOX_ENV] ? " Its step graph shows in the user's side panel and updates by itself." : "";
      return `Created workflow ${wf.id}.${shown}\n\n${await this.#advance(wf)}`;
    });
  }

  async next(rawArgs: unknown): Promise<string> {
    const { root, id } = target(rawArgs);
    return this.#serial(root, async () => this.#advance(await load(root, id)));
  }

  async run(rawArgs: unknown): Promise<string> {
    const { root, id, args } = target(rawArgs);
    return this.#serial(root, async () => {
      const wf = await load(root, id);
      if (args.concurrency !== undefined && args.concurrency !== null) wf.concurrency = args.concurrency as number;
      const lost = wf.recover();
      const lead = lost ? `Requeued ${lost} step(s) whose subagent was gone.\n\n` : "";
      return lead + (await this.#advance(wf));
    });
  }

  async addTask(rawArgs: unknown): Promise<string> {
    const { root, id, args } = target(rawArgs);
    const task = parseTask(args.task);
    const rawBlocks = args.blocks === undefined || args.blocks === null ? [] : args.blocks;
    if (!Array.isArray(rawBlocks)) throw new InputError("blocks must be an array of step ids.");
    const blocks = rawBlocks.map((b, i) => text(b, `blocks[${i}]`));
    return this.#serial(root, async () => {
      const wf = await load(root, id);
      const [added] = wf.addTasks([task], blocks);
      return `Added step "${added}".\n\n${await this.#advance(wf)}`;
    });
  }

  async answer(rawArgs: unknown): Promise<string> {
    const { root, id, args } = target(rawArgs);
    const nodeId = text(args.nodeId, "nodeId");
    const answer = text(args.answer, "answer");
    const check = optionalText(args.check, "check");
    return this.#serial(root, async () => {
      const wf = await load(root, id);
      const entry = wf.answer(nodeId, answer, check);
      const lead = entry.includes("; check changed")
        ? `⚠ Step "${nodeId}": ${entry}. Tell the user the check changed.`
        : `Step "${nodeId}": ${entry}.`;
      return `${lead}\n\n${await this.#advance(wf)}`;
    });
  }

  async report(rawArgs: unknown): Promise<string> {
    const { root, id, args } = target(rawArgs);
    const stepId = text(args.stepId, "stepId");
    const attempt = args.attempt;
    if (!Number.isInteger(attempt)) throw new InputError("attempt must be the attempt number from the launch.");
    let parsed: { outcome: Outcome } | { error: string };
    try {
      parsed = { outcome: parseOutcome(args.report) };
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      parsed = { error: error.message };
    }

    const command = await this.#serial(root, async () => {
      const wf = await load(root, id);
      current(wf, stepId, attempt as number);
      return "outcome" in parsed ? wf.checkFor(stepId, parsed.outcome) : undefined;
    });
    // Outside the queue: a slow check doesn't hold up other calls.
    const check = command === undefined ? undefined : await this.#check(command, root);

    return this.#serial(root, async () => {
      const wf = await load(root, id);
      current(wf, stepId, attempt as number);
      const applied = "outcome" in parsed ? wf.apply(stepId, parsed.outcome, check) : wf.retryOrAsk(stepId, parsed.error);
      const lead = `Step "${stepId}" (attempt ${attempt}): ${describe(wf, stepId, applied, check)}`;
      return `${lead}\n\n${await this.#advance(wf)}`;
    });
  }

  async status(rawArgs: unknown): Promise<string> {
    const args = record(rawArgs ?? {}, "arguments");
    const root = rootOf(args.cwd);
    const id = optionalText(args.workflowId, "workflowId");
    return this.#serial(root, async () => {
      if (id) {
        const wf = await load(root, id);
        return `State: ${stateOf(wf)}\n${wf.statusText()}`;
      }
      const all = await loadAll(root);
      if (!all.length) return `No workflows in ${root}.`;
      return all.map((wf) => `- ${wf.id}: ${stateOf(wf)}. ${wf.goal}`).join("\n");
    });
  }

  async view(rawArgs: unknown): Promise<string> {
    const { root, id } = target(rawArgs);
    return this.#serial(root, async () => {
      const wf = await load(root, id);
      const html = viewHtml(wf, stateOf(wf));
      return `Show this with canvas_show: name "workflow-${wf.id}", title ${JSON.stringify(clip(wf.goal, 80))}, kind "html", content:\n${html}`;
    });
  }

  /** Hands out ready steps up to the concurrency, saves, and says what the main agent does next. */
  async #advance(wf: Workflow): Promise<string> {
    const started = [];
    while (wf.inFlight().length < wf.concurrency) {
      const node = wf.startNext();
      if (!node) break;
      started.push(node.id);
    }
    // Built after every step started, so each prompt lists the others as running.
    const launches: Launch[] = started.map((stepId) => ({
      stepId,
      attempt: wf.node(stepId).data.attempts,
      prompt: buildPrompt(wf, stepId),
    }));
    await wf.flush();
    await publishCanvas(wf, stateOf(wf), this.#env);
    return nextText(wf, launches);
  }

  #serial<T>(root: string, task: () => Promise<T>): Promise<T> {
    const result = (this.#queues.get(root) ?? Promise.resolve()).then(task);
    this.#queues.set(
      root,
      result.catch(() => {}),
    );
    return result;
  }
}

export function nextText(wf: Workflow, launches: Launch[]): string {
  if (wf.graph.isComplete) {
    const changes = wf.changes();
    const lines = [`Workflow ${wf.id} is done: all ${wf.graph.size} steps finished and the goal check passed.`];
    if (changes.length) lines.push("Answers and check changes (tell the user):", ...changes.map((c) => `- ${c}`));
    return lines.join("\n");
  }
  const parts: string[] = [];
  if (launches.length) {
    const blocks = launches.map(
      (l) =>
        `### workflowId "${wf.id}", stepId "${l.stepId}", attempt ${l.attempt}\n<step-prompt>\n${l.prompt}\n</step-prompt>`,
    );
    parts.push([LAUNCH, ...blocks].join("\n\n"));
  }
  const launched = new Set(launches.map((l) => l.stepId));
  const out = wf.inFlight().filter((n) => !launched.has(n.id));
  if (out.length) {
    parts.push(
      `Waiting for the reports of: ${out.map((n) => `${n.id} (attempt ${n.data.attempts})`).join(", ")}. Report each when its subagent finishes.`,
    );
  }
  const questions = wf.questions();
  if (questions.length) parts.push(questionsText(questions));
  if (!parts.length) parts.push(`Nothing can run and nothing waits for the user.\n${wf.statusText()}`);
  return parts.join("\n\n");
}

export function questionsText(questions: Question[]): string {
  const lines = questions.map((q) => `- workflow ${q.workflowId}, step ${q.nodeId} (${q.title}): ${q.question}`);
  return `Steps waiting for the user's answer:\n${lines.join("\n")}\n${ASK}`;
}

export function stateOf(wf: Workflow): string {
  if (wf.graph.isComplete) return "done";
  const parts = [];
  const out = wf.inFlight().length;
  if (out) parts.push(`${out} step(s) handed out to subagents`);
  const asking = wf.questions().length;
  if (asking) parts.push(`${asking} step(s) wait for the user's answer`);
  if (!out && wf.graph.count("ready")) parts.push("paused (dw_run resumes it)");
  return parts.join("; ") || "stuck";
}

/** Every workflow of a project; unreadable files are skipped. */
export async function loadAll(root: string): Promise<Workflow[]> {
  const files = await loadWorkflowFiles(root, () => {});
  const all = [];
  for (const { path, doc } of files) {
    try {
      all.push(Workflow.load(root, path, doc));
    } catch {
      // Not a usable workflow file.
    }
  }
  return all;
}

async function load(root: string, id: string): Promise<Workflow> {
  const all = await loadAll(root);
  const wf = all.find((w) => w.id === id);
  if (!wf) {
    const known = all.map((w) => w.id).join(", ") || "none";
    throw new InputError(`There is no workflow "${id}" in ${root}. Known workflows: ${known}.`);
  }
  return wf;
}

/** Rejects a report for an attempt that is no longer running, such as one requeued by dw_run. */
function current(wf: Workflow, stepId: string, attempt: number): void {
  const node = wf.node(stepId);
  if (!wf.inFlight().some((n) => n.id === stepId) || node.data.attempts !== attempt) {
    throw new InputError(
      `Step "${stepId}" attempt ${attempt} is not running (the step is ${wf.isWaiting(node) ? "waiting for the user" : node.state}, attempt ${node.data.attempts}), so this report is ignored.`,
    );
  }
}

function describe(wf: Workflow, id: string, applied: Applied, check: CheckResult | undefined): string {
  switch (applied) {
    case "done":
      return check ? "done, and its check passed." : "done.";
    case "blocked":
      return "blocked; it runs again after the steps it added.";
    case "question":
      return "needs the user.";
    case "retry":
      return `not accepted; it runs again.\n${clip(wf.node(id).data.lastError ?? "", 1500)}`;
  }
}

function target(rawArgs: unknown) {
  const args = record(rawArgs, "arguments");
  return { args, root: rootOf(args.cwd), id: text(args.workflowId, "workflowId") };
}

function rootOf(raw: unknown): string {
  const cwd = text(raw, "cwd");
  if (!isAbsolute(cwd)) throw new InputError("cwd must be the absolute path of your current working directory.");
  return projectRoot(cwd);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
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

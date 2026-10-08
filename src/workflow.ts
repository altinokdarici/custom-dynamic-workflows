import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { PriorityGraph, type GraphNode } from "@altinokdarici/p-graph";
import { InputError } from "./parse.ts";
import { FileStore, workflowPath } from "./store.ts";
import { normalizeError, slug } from "./text.ts";
import type {
  CheckResult,
  EdgeData,
  NodeData,
  Outcome,
  PassResult,
  Question,
  TaskInput,
  WorkflowFile,
} from "./types.ts";

/** Id of the final node, which depends on every other node and verifies the goal. */
export const GOAL = "goal";
/** The goal node must not lift its prerequisites' priority (they inherit from dependents). */
const GOAL_PRIORITY = Number.MIN_SAFE_INTEGER;
const OPTIONS = { inheritPriority: true };
const INTERRUPTED =
  "Interrupted before it reported (the session or the run ended), so it may have done part of the work. Check the current state before you continue.";

type Graph = PriorityGraph<NodeData, EdgeData>;
type Node = GraphNode<NodeData>;

export interface CreateInput {
  goal: string;
  concurrency: number;
  tasks: TaskInput[];
  goalCheck?: string;
  goalCwd?: string;
}

/** What `apply` did with a report. */
export type Applied = "done" | "blocked" | "retry" | "question";

/**
 * One workflow: a p-graph of steps plus the rules for applying step reports.
 * Every graph change goes through here and is persisted by the FileStore.
 * Methods are synchronous, so concurrent steps never see a half-applied report.
 */
export class Workflow {
  readonly root: string;
  readonly graph: Graph;
  readonly #store: FileStore;

  private constructor(root: string, store: FileStore, graph: Graph) {
    this.root = root;
    this.#store = store;
    this.graph = graph;
  }

  static create(root: string, input: CreateInput): Workflow {
    const goal = input.goal?.trim();
    if (!goal) throw new InputError("goal must be a non-empty string.");
    if (!Number.isInteger(input.concurrency) || input.concurrency < 1) {
      throw new InputError("concurrency must be a whole number of at least 1.");
    }
    if (!input.tasks.length) throw new InputError("tasks must contain at least one step.");

    const id = `${slug(goal, 32) || "workflow"}-${randomBytes(2).toString("hex")}`;
    const doc: WorkflowFile = {
      version: 1,
      id,
      goal,
      concurrency: input.concurrency,
      createdAt: new Date().toISOString(),
      graph: { version: 1, nodes: [], dependencies: [] },
    };
    const store = new FileStore(workflowPath(root, id), doc);
    const wf = new Workflow(root, store, new PriorityGraph<NodeData, EdgeData>({ ...OPTIONS, store }));
    const goalData: NodeData = { title: "Check the goal", instructions: "", attempts: 0 };
    if (input.goalCheck) goalData.check = input.goalCheck;
    if (input.goalCwd) goalData.cwd = input.goalCwd;
    wf.#transact((g) => {
      const ids = addTasks(g, input.tasks, { exactIds: true });
      g.addNode(GOAL, goalData, { priority: GOAL_PRIORITY, dependsOn: ids });
    });
    return wf;
  }

  static load(root: string, path: string, doc: WorkflowFile): Workflow {
    const store = new FileStore(path, doc);
    const graph = PriorityGraph.fromSnapshot(structuredClone(doc.graph), { ...OPTIONS, store });
    return new Workflow(root, store, graph);
  }

  get id(): string {
    return this.#store.doc.id;
  }

  get goal(): string {
    return this.#store.doc.goal;
  }

  get concurrency(): number {
    return this.#store.doc.concurrency;
  }

  set concurrency(value: number) {
    if (!Number.isInteger(value) || value < 1) {
      throw new InputError("concurrency must be a whole number of at least 1.");
    }
    this.#store.doc.concurrency = value;
    this.#store.touch();
  }

  node(id: string): Node {
    const node = this.graph.get(id);
    if (!node) throw new InputError(`Workflow ${this.id} has no step "${id}".`);
    return node;
  }

  cwdOf(id: string): string {
    return resolve(this.root, this.node(id).data.cwd ?? ".");
  }

  /** A step that asked the user something and has no answer yet. */
  isWaiting(node: Node): boolean {
    return node.state === "in-progress" && node.data.question !== undefined && node.data.answer === undefined;
  }

  questions(): Question[] {
    return [...this.graph.nodes("in-progress")]
      .filter((node) => this.isWaiting(node))
      .map((node) => ({
        workflowId: this.id,
        nodeId: node.id,
        title: node.data.title,
        question: node.data.question!,
      }));
  }

  /** Ready steps, or steps left in progress by a run that stopped. Only meaningful while no run is active. */
  hasRunnableWork(): boolean {
    return (
      this.graph.count("ready") > 0 || [...this.graph.nodes("in-progress")].some((node) => !this.isWaiting(node))
    );
  }

  /** Puts steps left in progress by an interrupted run back in the queue, telling their next attempt why. */
  recover(): number {
    let count = 0;
    for (const node of [...this.graph.nodes("in-progress")]) {
      if (!this.isWaiting(node)) {
        this.graph.setData(node.id, { ...node.data, lastError: INTERRUPTED });
        this.graph.requeue(node.id);
        count++;
      }
    }
    return count;
  }

  /** Takes the next ready step and counts the attempt. */
  startNext(): Node | undefined {
    const node = this.graph.dequeue();
    if (!node) return undefined;
    this.graph.setData(node.id, { ...node.data, attempts: node.data.attempts + 1 });
    return this.graph.get(node.id);
  }

  /** Adds steps; `blocks` lists existing steps that must wait for them. Returns the new ids. */
  addTasks(tasks: TaskInput[], blocks: string[] = []): string[] {
    return this.#transact((g) => {
      for (const id of blocks) {
        const state = g.get(id)?.state;
        if (!state) throw new InputError(`Workflow ${this.id} has no step "${id}".`);
        if (state !== "pending" && state !== "ready") {
          throw new InputError(`Step "${id}" is ${state}; only steps that have not started can wait for new steps.`);
        }
      }
      const ids = addTasks(g, tasks);
      for (const id of blocks) for (const added of ids) g.addDependency(id, added);
      return ids;
    });
  }

  /** The check to run before `apply`, when the report would complete the step. */
  checkFor(id: string, outcome: Outcome): string | undefined {
    if (effectiveStatus(id, outcome) !== "done" || this.#unfinishedBeforeGoal(id).length) return undefined;
    return this.node(id).data.check;
  }

  /** Steps added while the goal step ran that are not finished; the goal cannot complete before them. */
  #unfinishedBeforeGoal(id: string): string[] {
    if (id !== GOAL) return [];
    return [...this.graph.nodes()].filter((n) => n.id !== GOAL && n.state !== "completed").map((n) => n.id);
  }

  /** Applies a step's report. `check` is the result of `checkFor`'s command. */
  apply(id: string, outcome: Outcome, check?: CheckResult): Applied {
    this.#requireInProgress(id);
    switch (effectiveStatus(id, outcome)) {
      case "done": {
        const late = this.#unfinishedBeforeGoal(id);
        if (late.length) {
          return this.#tryTransact(id, (g) => {
            g.requeue(id);
            for (const dep of late) g.addDependency(id, dep, { label: "added while the goal ran" });
            return "blocked";
          });
        }
        if (check && !check.ok) return this.retryOrAsk(id, `The check failed:\n${check.output}`);
        return this.#tryTransact(id, (g) => {
          const ids = addTasks(g, outcome.newTasks ?? []);
          // Work found while doing a step belongs to it: whatever waited for the step waits for that too.
          for (const dependent of g.dependentsOf(id)) {
            if (dependent === GOAL) continue;
            for (const added of ids) g.addDependency(dependent, added, { label: `found by ${id}` });
          }
          g.setData(id, { ...g.get(id)!.data, result: outcome.summary || "(no summary)" });
          g.complete(id);
          return "done";
        });
      }
      case "blocked": {
        if (!outcome.newTasks?.length) {
          return this.retryOrAsk(id, "The step reported blocked without newTasks saying what has to happen first.");
        }
        const requested = id === GOAL ? requestedTitles(outcome.newTasks) : undefined;
        if (requested !== undefined) {
          const data = this.node(id).data;
          if (data.lastRequested?.join("\n") === requested.join("\n")) {
            this.graph.setData(id, { ...data, lastRequested: undefined });
            this.#ask(
              id,
              `The goal check asked for the same work twice in a row (${requested.join(", ")}), so it is not added again. The work did not satisfy the goal check:\n${outcome.summary || "(no summary)"}\n\nHow should it continue?`,
            );
            return "question";
          }
        }
        return this.#tryTransact(id, (g) => {
          g.requeue(id);
          if (requested !== undefined) g.setData(id, { ...g.get(id)!.data, lastRequested: requested });
          for (const added of addTasks(g, outcome.newTasks!)) {
            g.addDependency(id, added, { label: "needed first" });
          }
          return "blocked";
        });
      }
      case "needs_user": {
        if (!outcome.question) return this.retryOrAsk(id, "The step reported needs_user without a question.");
        this.#ask(id, outcome.question);
        return "question";
      }
      case "failed": {
        const reason = outcome.summary || "(no reason given)";
        this.graph.setData(id, { ...this.node(id).data, lastError: reason });
        this.#ask(id, `This step failed: ${reason}\nHow should it continue?`);
        return "question";
      }
    }
  }

  /** Retries a failed attempt, or asks the user when it failed the same way as the last one. */
  retryOrAsk(id: string, error: string): Applied {
    const data = this.#requireInProgress(id).data;
    if (data.lastError !== undefined && normalizeError(data.lastError) === normalizeError(error)) {
      this.#ask(id, `This step failed the same way twice:\n${error}\n\nHow should it continue?`);
      return "question";
    }
    this.graph.setData(id, { ...data, lastError: error });
    this.graph.requeue(id);
    return "retry";
  }

  /** Records the user's answer and puts the step back in the queue. */
  answer(id: string, text: string): void {
    const node = this.node(id);
    if (!this.isWaiting(node)) throw new InputError(`Step "${id}" is not waiting for an answer.`);
    if (!text.trim()) throw new InputError("answer must be a non-empty string.");
    this.graph.setData(id, { ...node.data, answer: text.trim() });
    this.graph.requeue(id);
  }

  passResult(): PassResult {
    if (this.graph.isComplete) return { status: "done", workflowId: this.id, steps: this.graph.size };
    const questions = this.questions();
    if (questions.length) return { status: "waiting", workflowId: this.id, questions };
    return { status: "stuck", workflowId: this.id, summary: this.statusText() };
  }

  statusText(): string {
    const g = this.graph;
    const counts = (["completed", "in-progress", "ready", "pending"] as const)
      .map((state) => `${g.count(state)} ${state}`)
      .join(", ");
    const lines = [`Workflow ${this.id}: ${this.goal}`, `Concurrency ${this.concurrency}. Steps: ${counts}.`];
    for (const node of g.nodes()) lines.push(this.#statusLine(node));
    return lines.join("\n");
  }

  flush(): Promise<void> {
    return this.#store.flush();
  }

  #statusLine(node: Node): string {
    const d = node.data;
    const waiting = this.isWaiting(node);
    const state = waiting ? "waiting for user" : node.state;
    let line = `- [${state}] ${node.id}: ${d.title}`;
    if (d.attempts > 1) line += ` (attempt ${d.attempts})`;
    if (node.state === "pending") {
      const open = node.dependencies.filter((dep) => this.graph.get(dep)?.state !== "completed");
      line += `, waits for ${open.join(", ")}`;
    }
    if (waiting) line += `\n    Question: ${d.question}`;
    else if (node.state === "completed") line += `\n    ${clip(d.result ?? "")}`;
    else if (d.lastError) line += `\n    Last error: ${clip(d.lastError)}`;
    return line;
  }

  #ask(id: string, question: string): void {
    const data = this.node(id).data;
    this.graph.setData(id, { ...data, question, answer: undefined });
  }

  #requireInProgress(id: string): Node {
    const node = this.node(id);
    if (node.state !== "in-progress") throw new Error(`Step "${id}" is ${node.state}, not in progress.`);
    return node;
  }

  /** Runs `change` on a scratch copy first, so a change that throws leaves the graph untouched. */
  #transact<R>(change: (g: Graph) => R): R {
    change(PriorityGraph.fromSnapshot(structuredClone(this.graph.toSnapshot()), OPTIONS));
    return change(this.graph);
  }

  #tryTransact(id: string, change: (g: Graph) => Applied): Applied {
    try {
      return this.#transact(change);
    } catch (error) {
      return this.retryOrAsk(id, `The report could not be applied: ${(error as Error).message}`);
    }
  }
}

/** The goal check cannot pass while it still lists work to do. */
function effectiveStatus(id: string, outcome: Outcome): Outcome["status"] {
  return id === GOAL && outcome.status === "done" && outcome.newTasks?.length ? "blocked" : outcome.status;
}

/** Sorted, normalized titles, so the same work asked for in another order or wording of whitespace compares equal. */
function requestedTitles(tasks: readonly TaskInput[]): string[] {
  return tasks.map((t) => t.title.replace(/\s+/g, " ").trim().toLowerCase()).sort();
}

/**
 * Adds a batch of steps. Ids are slugged; an id already in the graph gets a
 * numeric suffix unless `exactIds` is set. `dependsOn` refers to ids in the
 * batch first, then to existing steps. New steps also become prerequisites of
 * the goal check while it has not started.
 */
function addTasks(g: Graph, tasks: readonly TaskInput[], { exactIds = false } = {}): string[] {
  const keys = tasks.map((task) => slug(task.id));
  const ids = new Map<string, string>();
  for (const [i, key] of keys.entries()) {
    if (!key) throw new InputError(`Step "${tasks[i]!.title}" needs an id made of letters or digits.`);
    if (key === GOAL) throw new InputError(`"${GOAL}" is reserved for the final goal check.`);
    if (ids.has(key)) throw new InputError(`Two steps use the id "${key}".`);
    let id = key;
    if (exactIds && g.has(id)) throw new InputError(`A step with id "${id}" already exists.`);
    for (let n = 2; g.has(id) || [...ids.values()].includes(id) || (id !== key && keys.includes(id)); n++) {
      id = `${key}-${n}`;
    }
    ids.set(key, id);
  }

  for (const [i, task] of tasks.entries()) {
    const data: NodeData = { title: task.title, instructions: task.instructions, attempts: 0 };
    if (task.check) data.check = task.check;
    if (task.cwd) data.cwd = task.cwd;
    g.addNode(ids.get(keys[i]!)!, data, task.priority === undefined ? {} : { priority: task.priority });
  }

  for (const [i, task] of tasks.entries()) {
    const id = ids.get(keys[i]!)!;
    for (const dep of task.dependsOn ?? []) {
      const { id: ref, label } = typeof dep === "string" ? { id: dep, label: undefined } : dep;
      const target = ids.get(slug(ref)) ?? (g.has(ref) ? ref : g.has(slug(ref)) ? slug(ref) : undefined);
      if (!target) throw new InputError(`Step "${id}" depends on "${ref}", which does not exist.`);
      if (target === GOAL) throw new InputError(`Step "${id}" cannot depend on the goal check.`);
      g.addDependency(id, target, label ? { label } : undefined);
    }
  }

  const goal = g.get(GOAL);
  if (goal && (goal.state === "pending" || goal.state === "ready")) {
    for (const id of ids.values()) g.addDependency(GOAL, id);
  }
  return [...ids.values()];
}

function clip(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

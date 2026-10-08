import type { GraphSnapshot } from "@altinokdarici/p-graph";

/** What the planner writes for a step. */
export interface NodeSpec {
  title: string;
  instructions: string;
  /** Shell command run by the driver (not the agent) after the step reports done. */
  check?: string;
  /** Directory the step works in, relative to the project root (e.g. a git worktree). */
  cwd?: string;
}

/** What the graph stores per node: the spec plus fields only the driver writes. */
export interface NodeData extends NodeSpec {
  attempts: number;
  lastError?: string;
  /** Goal node only: normalized titles of the work its last report asked for. */
  lastRequested?: string[];
  result?: string;
  question?: string;
  answer?: string;
}

export interface EdgeData {
  label: string;
}

export type DepInput = string | { id: string; label?: string };

/** A step as given by the planner (dw_plan, dw_add_task) or by an agent (newTasks). */
export interface TaskInput extends NodeSpec {
  id: string;
  priority?: number;
  dependsOn?: DepInput[];
}

export type OutcomeStatus = "done" | "blocked" | "needs_user" | "failed";

/** The report every step agent ends with. */
export interface Outcome {
  status: OutcomeStatus;
  summary: string;
  question?: string;
  newTasks?: TaskInput[];
}

export interface WorkflowFile {
  version: 1;
  id: string;
  goal: string;
  concurrency: number;
  createdAt: string;
  graph: GraphSnapshot<NodeData, EdgeData>;
}

export interface CheckResult {
  ok: boolean;
  output: string;
}

export type Question = {
  workflowId: string;
  nodeId: string;
  title: string;
  question: string;
};

export type PassResult =
  | { status: "done"; workflowId: string; steps: number }
  | { status: "waiting"; workflowId: string; questions: Question[] }
  | { status: "stuck"; workflowId: string; summary: string };

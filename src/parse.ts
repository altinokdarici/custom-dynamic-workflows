import type { DepInput, Outcome, OutcomeStatus, TaskInput } from "./types.ts";

const STATUSES: readonly OutcomeStatus[] = ["done", "blocked", "needs_user", "failed"];

/** Bad input from the model; the message is written for the model to fix it. */
export class InputError extends Error {}

export function parseTasks(raw: unknown, where = "tasks"): TaskInput[] {
  if (!Array.isArray(raw)) throw new InputError(`${where} must be an array.`);
  return raw.map((item, i) => parseTask(item, `${where}[${i}]`));
}

export function parseTask(raw: unknown, where = "task"): TaskInput {
  const o = record(raw, where);
  const title = text(o.title, `${where}.title`);
  const task: TaskInput = {
    id: optionalText(o.id, `${where}.id`) ?? title,
    title,
    instructions: text(o.instructions, `${where}.instructions`),
  };
  const check = optionalText(o.check, `${where}.check`);
  if (check) task.check = check;
  const cwd = optionalText(o.cwd, `${where}.cwd`);
  if (cwd) task.cwd = cwd;
  if (o.priority !== undefined && o.priority !== null) {
    if (typeof o.priority !== "number" || !Number.isFinite(o.priority)) {
      throw new InputError(`${where}.priority must be a number.`);
    }
    task.priority = o.priority;
  }
  if (o.dependsOn !== undefined && o.dependsOn !== null) {
    if (!Array.isArray(o.dependsOn)) throw new InputError(`${where}.dependsOn must be an array.`);
    task.dependsOn = o.dependsOn.map((dep, i) => parseDep(dep, `${where}.dependsOn[${i}]`));
  }
  return task;
}

function parseDep(raw: unknown, where: string): DepInput {
  if (typeof raw === "string") return text(raw, where);
  const o = record(raw, where);
  const id = text(o.id, `${where}.id`);
  const label = optionalText(o.label, `${where}.label`);
  return label ? { id, label } : id;
}

/** Validates a step agent's report. */
export function parseOutcome(raw: unknown): Outcome {
  if (raw === null || raw === undefined) throw new InputError("The step ended without a report.");
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new InputError("The step's report was not valid JSON.");
    }
  }
  const o = record(raw, "report");
  if (!STATUSES.includes(o.status as OutcomeStatus)) {
    throw new InputError(`report.status must be one of: ${STATUSES.join(", ")}.`);
  }
  const outcome: Outcome = {
    status: o.status as OutcomeStatus,
    summary: typeof o.summary === "string" ? o.summary.trim() : "",
  };
  const question = optionalText(o.question, "report.question");
  if (question) outcome.question = question;
  if (o.newTasks !== undefined && o.newTasks !== null) {
    const tasks = parseTasks(o.newTasks, "report.newTasks");
    if (tasks.length) outcome.newTasks = tasks;
  }
  return outcome;
}

export function record(raw: unknown, where: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InputError(`${where} must be an object.`);
  }
  return raw as Record<string, unknown>;
}

export function text(raw: unknown, where: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new InputError(`${where} must be a non-empty string.`);
  return raw.trim();
}

export function optionalText(raw: unknown, where: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new InputError(`${where} must be a string.`);
  return raw.trim() || undefined;
}

import { defineWorkflow, joinSession, type JoinSessionConfig } from "@github/copilot-sdk/extension";
import { runCheck } from "./check.ts";
import { runPass } from "./driver.ts";
import { Host, projectRoot, type LogLevel } from "./host.ts";
import { OUTCOME_SCHEMA } from "./prompt.ts";
import type { PassResult } from "./types.ts";

type Session = Awaited<ReturnType<typeof joinSession>>;
type Tool = NonNullable<JoinSessionConfig["tools"]>[number];

let session: Session | undefined;
let pausedHinted = false;

// stdout is the JSON-RPC channel, so everything user-visible goes through session.log.
function log(message: string, level: LogLevel = "info"): void {
  session?.log(message, { level }).catch(() => {});
}

const host = new Host({
  root: () => projectRoot(process.cwd()),
  startPass: async (wf) => {
    if (!session) throw new Error("The extension is not connected to a session yet.");
    const run = await session.workflow.run(drive, { args: { workflowId: wf.id }, notifyOnComplete: true });
    if (run.status === "completed") return run.result as PassResult;
    log(`Workflow ${wf.id}: run ${run.runId} ended ${run.status}${run.error ? `: ${run.error}` : ""}.`, "warning");
    return undefined;
  },
  log,
});

/** One pass over a workflow, run as an SDK dynamic workflow so steps are real subagents. */
const drive = defineWorkflow<{ workflowId: string }, PassResult>({
  meta: {
    name: "dw-drive",
    description: "Runs the ready steps of a dynamic workflow until it is done or waits for the user.",
    phases: [{ title: "Run steps" }],
    argsSchema: { type: "object", required: ["workflowId"], properties: { workflowId: { type: "string" } } },
  },
  run: async (ctx) => {
    const wf = host.get(ctx.args.workflowId);
    ctx.phase("Run steps");
    return runPass(wf, {
      agent: (prompt, label) => ctx.agent(prompt, { label, schema: OUTCOME_SCHEMA }),
      check: runCheck,
      wake: host.wake(wf.id),
      signal: ctx.signal,
      log: (message) => ctx.log(message),
      onQuestion: (q) => log(`Workflow ${q.workflowId}: step "${q.nodeId}" asks: ${q.question}`, "warning"),
    });
  },
});

const TASK_SCHEMA = {
  type: "object",
  required: ["id", "title", "instructions"],
  properties: {
    id: { type: "string", description: "Unique kebab-case id, e.g. migrate-skill-foo." },
    title: { type: "string", description: "Short name of the step." },
    instructions: {
      type: "string",
      description:
        "Self-contained instructions: what to do, where, and what done looks like. The step's agent sees only these, the goal, and the results of the steps it depends on.",
    },
    check: {
      type: "string",
      description:
        "Shell command the driver runs in cwd after the step reports done; exit code 0 means done. Prefer one whenever done can be verified by a command.",
    },
    cwd: {
      type: "string",
      description: "Directory to work in, relative to the repo root (for example a git worktree). Defaults to the repo root.",
    },
    priority: { type: "number", description: "Among ready steps, higher runs first. Default 0." },
    dependsOn: {
      type: "array",
      description: "Steps that must finish first: ids, or {id, label} where the label says why.",
      items: {
        anyOf: [
          { type: "string" },
          { type: "object", required: ["id"], properties: { id: { type: "string" }, label: { type: "string" } } },
        ],
      },
    },
  },
};

const WORKFLOW_ID = { type: "string", description: "Workflow id returned by dw_plan." };

function tool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: (args: unknown, signal?: AbortSignal) => Promise<string>,
  options: { skipPermission?: boolean } = {},
): Tool {
  return {
    name,
    description,
    parameters,
    defer: "never",
    ...options,
    handler: async (args, invocation) => {
      try {
        return await handler(args, invocation.signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { textResultForLlm: `Error: ${message}`, resultType: "failure", error: message };
      }
    },
  };
}

const tools: Tool[] = [
  tool(
    "dw_plan",
    "Start a dynamic workflow: a dependency graph of steps that runs in the background until every step is done and a final goal check passes. Each step runs as its own agent; ready steps run in parallel up to `concurrency`. Steps can add follow-up steps, and failing checks are retried with their output. Use for work that splits into several stage-sized steps (see the dynamic-workflow skill).",
    {
      type: "object",
      required: ["goal", "concurrency", "tasks"],
      properties: {
        goal: { type: "string", description: "What the whole workflow must achieve, as the user would check it." },
        concurrency: {
          type: "number",
          description:
            "How many steps may run at once. Choose it from how independent the steps are: steps running together must not edit the same files (use separate git worktrees for parallel branch work).",
        },
        tasks: { type: "array", items: TASK_SCHEMA, description: "The steps. Ids must be unique." },
        goalCheck: { type: "string", description: "Optional shell command that must pass for the goal check to succeed." },
        goalCwd: { type: "string", description: "Directory for goalCheck, relative to the repo root." },
      },
    },
    (args) => host.plan(args),
  ),
  tool(
    "dw_run",
    "Resume a workflow that is paused (for example after a restart or an error), optionally changing its concurrency.",
    {
      type: "object",
      required: ["workflowId"],
      properties: { workflowId: WORKFLOW_ID, concurrency: { type: "number" } },
    },
    (args) => host.run(args),
  ),
  tool(
    "dw_add_task",
    "Add a step to a workflow. `blocks` lists existing steps that have not started yet and must wait for the new one.",
    {
      type: "object",
      required: ["workflowId", "task"],
      properties: {
        workflowId: WORKFLOW_ID,
        task: TASK_SCHEMA,
        blocks: { type: "array", items: { type: "string" } },
      },
    },
    (args) => host.addTask(args),
  ),
  tool(
    "dw_answer",
    "Answer a question a workflow step asked the user. Pass the user's answer, not your own guess. The step then runs again with it.",
    {
      type: "object",
      required: ["workflowId", "nodeId", "answer"],
      properties: { workflowId: WORKFLOW_ID, nodeId: { type: "string" }, answer: { type: "string" } },
    },
    (args) => host.answer(args),
    { skipPermission: true },
  ),
  tool(
    "dw_status",
    "Show a workflow's steps, results, errors and open questions, or list all workflows when workflowId is omitted. With wait=true, first wait until the workflow stops running (done, or waiting for the user).",
    {
      type: "object",
      properties: { workflowId: WORKFLOW_ID, wait: { type: "boolean" } },
    },
    (args, signal) => host.status(args, signal),
    { skipPermission: true },
  ),
];

session = await joinSession({
  workflows: [drive],
  tools,
  hooks: {
    onUserPromptSubmitted: async () => {
      await host.load();
      const parts: string[] = [];
      const questions = host.questions();
      if (questions.length) {
        const lines = questions.map((q) => `- workflow ${q.workflowId}, step ${q.nodeId} (${q.title}): ${q.question}`);
        parts.push(
          `Dynamic workflow steps are waiting for the user's answer:\n${lines.join("\n")}\nIf the user's message answers one, pass it to dw_answer. Otherwise mention that these questions are open.`,
        );
      }
      if (!pausedHinted) {
        pausedHinted = true;
        const paused = await host.paused();
        if (paused.length) {
          const lines = paused.map((wf) => `- ${wf.id}: ${wf.goal}`);
          parts.push(
            `These dynamic workflows of this project are paused with work left:\n${lines.join("\n")}\nMention them to the user and offer to resume with dw_run. Never resume without the user asking.`,
          );
        }
      }
      if (parts.length) return { additionalContext: parts.join("\n\n") };
    },
  },
});

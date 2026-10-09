import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Host } from "./host.ts";

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
        "Shell command the workflow runs from the repo root after the step reports done; exit code 0 means done. For a step in a worktree, cd into it first: `cd .worktrees/foo && npm test`. Prefer one whenever done can be verified by a command.",
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

const CWD = {
  type: "string",
  description: "Absolute path of your current working directory. Workflows belong to its git repository.",
};
const WORKFLOW_ID = { type: "string", description: "Workflow id returned by dw_plan." };
const LOOP = "Its reply lists the steps to launch as subagents and what to do next.";

const host = new Host();

type Handler = (args: unknown) => Promise<string>;
const tools: { name: string; description: string; inputSchema: Record<string, unknown>; handler: Handler }[] = [
  {
    name: "dw_plan",
    description: `Create a dynamic workflow: a dependency graph of steps that runs until every step is done and a final goal check passes. You run each step as its own subagent; checks run in code. Use for work that splits into several stage-sized steps (see the dynamic-workflow skill). ${LOOP}`,
    inputSchema: {
      type: "object",
      required: ["cwd", "goal", "concurrency", "tasks"],
      properties: {
        cwd: CWD,
        goal: { type: "string", description: "What the whole workflow must achieve, as the user would check it." },
        concurrency: {
          type: "number",
          description:
            "How many steps may run at once. Choose it from how independent the steps are: steps running together must not edit the same files (use separate git worktrees for parallel branch work).",
        },
        tasks: { type: "array", items: TASK_SCHEMA, description: "The steps. Ids must be unique." },
        goalCheck: {
          type: "string",
          description:
            "Optional shell command, run from the repo root, that must pass for the goal check to succeed. It can't be changed later.",
        },
      },
    },
    handler: (args) => host.plan(args),
  },
  {
    name: "dw_report",
    description: `Report a finished step subagent: pass its final message unchanged. The workflow reads the JSON report in it, runs the step's check, and records the result; a failing check sends the step back. ${LOOP}`,
    inputSchema: {
      type: "object",
      required: ["cwd", "workflowId", "stepId", "attempt", "report"],
      properties: {
        cwd: CWD,
        workflowId: WORKFLOW_ID,
        stepId: { type: "string" },
        attempt: { type: "number", description: "The attempt number the step was launched with." },
        report: { type: "string", description: "The subagent's final message, unchanged (or an error if it failed)." },
      },
    },
    handler: (args) => host.report(args),
  },
  {
    name: "dw_next",
    description: `Show what to do next for a workflow: steps to launch, reports still expected, questions for the user. ${LOOP}`,
    inputSchema: {
      type: "object",
      required: ["cwd", "workflowId"],
      properties: { cwd: CWD, workflowId: WORKFLOW_ID },
    },
    handler: (args) => host.next(args),
  },
  {
    name: "dw_answer",
    description: `Pass the user's answer to a question a step asked. If the step's check is wrong, pass a corrected \`check\` to replace it (not for the goal check); tell the user when you do. The step then runs again with the answer. Every answer and check change is kept and listed when the workflow finishes. ${LOOP}`,
    inputSchema: {
      type: "object",
      required: ["cwd", "workflowId", "nodeId", "answer"],
      properties: {
        cwd: CWD,
        workflowId: WORKFLOW_ID,
        nodeId: { type: "string", description: "The step that asked." },
        answer: { type: "string", description: "The user's answer." },
        check: { type: "string", description: "Replaces the step's check, run from the repo root." },
      },
    },
    handler: (args) => host.answer(args),
  },
  {
    name: "dw_add_task",
    description: `Add a step to a workflow. \`blocks\` lists existing steps that have not started yet and must wait for the new one. ${LOOP}`,
    inputSchema: {
      type: "object",
      required: ["cwd", "workflowId", "task"],
      properties: {
        cwd: CWD,
        workflowId: WORKFLOW_ID,
        task: TASK_SCHEMA,
        blocks: { type: "array", items: { type: "string" } },
      },
    },
    handler: (args) => host.addTask(args),
  },
  {
    name: "dw_run",
    description: `Resume a workflow whose steps were handed to subagents that are gone (another session, a restart): those steps run again. Optionally change its concurrency. Never use it while this session's subagents still run steps. ${LOOP}`,
    inputSchema: {
      type: "object",
      required: ["cwd", "workflowId"],
      properties: { cwd: CWD, workflowId: WORKFLOW_ID, concurrency: { type: "number" } },
    },
    handler: (args) => host.run(args),
  },
  {
    name: "dw_status",
    description:
      "Show a workflow's steps, results, errors and open questions, or list the repository's workflows when workflowId is omitted.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: { cwd: CWD, workflowId: WORKFLOW_ID },
    },
    handler: (args) => host.status(args),
  },
  {
    name: "dw_view",
    description:
      "Get a workflow's step graph, colored by status, as an HTML page for a canvas. If you have a canvas_show tool, pass the page to it unchanged as kind \"html\" with the name and title given.",
    inputSchema: {
      type: "object",
      required: ["cwd", "workflowId"],
      properties: { cwd: CWD, workflowId: WORKFLOW_ID },
    },
    handler: (args) => host.view(args),
  },
];

const server = new Server({ name: "dynamic-workflows", version: "0.3.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find((t) => t.name === request.params.name);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool ${request.params.name}.` }], isError: true };
  try {
    return { content: [{ type: "text", text: await tool.handler(request.params.arguments ?? {}) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());

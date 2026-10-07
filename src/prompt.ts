import { indent } from "./text.ts";
import { GOAL, type Workflow } from "./workflow.ts";
import type { WorkflowJsonSchema } from "@github/copilot-sdk/extension";

const GOAL_INSTRUCTIONS = `Every other step reports done. Check that the goal above is really met: inspect the actual files, branches, commits and command output instead of trusting the summaries below.
- If it is met, report done.
- If anything is missing or wrong, report blocked and describe the fixes as newTasks.`;

const RULES = `## Rules
- Do this step only. Other steps take care of the rest of the goal.
- Do not call any dw_* tool and do not edit .copilot/workflows; the workflow driver owns them.
- Never weaken, skip or delete checks or tests to make them pass.`;

const REPORT = `## Report
Finish with a report:
- "done": the step is finished. In summary, say what you did and what later steps need to know (paths, branch names, decisions). If you noticed work outside this step, add it as newTasks instead of doing it.
- "blocked": something else must happen before this step can finish. Describe it as newTasks; this step runs again after them.
- "needs_user": only the user can decide something. Ask in question; this step runs again with the answer.
- "failed": the step cannot be done. Say why in summary.
Each newTasks item has an id (short, kebab-case), a title, self-contained instructions, and optionally a check (a shell command that proves it is done), a cwd and dependsOn (ids of other new or existing steps).`;

/** JSON Schema for the report, passed to ctx.agent so the runtime enforces its shape. */
export const OUTCOME_SCHEMA: WorkflowJsonSchema = {
  type: "object",
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["done", "blocked", "needs_user", "failed"] },
    summary: { type: "string" },
    question: { type: "string" },
    newTasks: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "instructions"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          instructions: { type: "string" },
          check: { type: "string" },
          cwd: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/** Everything one step's agent needs, built fresh for every attempt. */
export function buildPrompt(wf: Workflow, id: string): string {
  const node = wf.node(id);
  const data = node.data;
  const parts = [
    "You are running one step of a larger workflow. Do the step completely, then report.",
    `## Workflow goal\n${wf.goal}`,
    id === GOAL
      ? `## Your step: check the goal (attempt ${data.attempts})\n${GOAL_INSTRUCTIONS}`
      : `## Your step: ${data.title} (id: ${id}, attempt ${data.attempts})\n${data.instructions}`,
    `Work in: ${wf.cwdOf(id)}`,
  ];
  if (data.check) {
    parts.push(
      `When you report done, the driver runs this check in that directory, and the step only counts as done if it passes:\n${indent(data.check, "    ")}\nRun it yourself before reporting and fix what fails.`,
    );
  }

  const deps = wf.graph.dependencyEdges(id);
  if (deps.length) {
    const lines = deps.map((edge) => {
      const dep = wf.node(edge.dependsOn);
      const label = edge.data?.label ? ` (${edge.data.label})` : "";
      return `- ${dep.id}: ${dep.data.title}${label}\n${indent(dep.data.result ?? "(no summary)", "    ")}`;
    });
    parts.push(`## Steps this one waited for\n${lines.join("\n")}`);
  }

  if (data.lastError) parts.push(`## Previous attempt\nThe previous attempt did not succeed:\n${indent(data.lastError)}`);
  if (data.question) {
    parts.push(`## Your question to the user\n${data.question}\n\nAnswer: ${data.answer ?? "(none yet)"}`);
  }

  const depIds = new Set(deps.map((edge) => edge.dependsOn));
  const others = [...wf.graph.nodes()].filter((other) => other.id !== id && other.id !== GOAL && !depIds.has(other.id));
  if (others.length) {
    const lines = others.map((other) => {
      const state = other.state === "in-progress" ? "running now" : other.state;
      return `- [${state}] ${other.id}: ${other.data.title}${other.data.cwd ? ` (in ${other.data.cwd})` : ""}`;
    });
    parts.push(
      `## Other steps in this workflow\n${lines.join("\n")}\nSteps marked "running now" run at the same time as this one; do not change files they own.`,
    );
  }

  parts.push(RULES, REPORT);
  return parts.join("\n\n");
}

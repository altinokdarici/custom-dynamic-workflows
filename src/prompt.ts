import { indent } from "./text.ts";

/** Most characters of earlier steps' summaries put in one prompt; the rest stays readable in the state file. */
export const RESULTS_BUDGET = 16_000;
const MIN_SHARE = 800;
import { GOAL, type Workflow } from "./workflow.ts";

const GOAL_INSTRUCTIONS = `Every other step reports done. Check that the goal above is really met: inspect the actual files, branches, commits and command output instead of trusting the summaries below.
- If it is met, report done.
- If anything is missing or wrong, report blocked and describe the fixes as newTasks.`;

const RULES = `## Rules
- Do this step only. Other steps take care of the rest of the goal.
- Do not call any dw_* tool and do not edit .copilot/workflows; the workflow owns them.
- Never weaken, skip or delete checks or tests to make them pass.`;



/** JSON Schema of the report, shown to the step agent. parseOutcome enforces it. */
export const OUTCOME_SCHEMA = {
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
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const REPORT = `## Report
Finish with a report:
- "done": the step is finished. In summary, say what you did and what later steps need to know (paths, branch names, decisions). If you noticed work outside this step, add it as newTasks instead of doing it.
- "blocked": something else must happen before this step can finish. Describe it as newTasks; this step runs again after them.
- "needs_user": only the user can decide something. Ask in question; this step runs again with the answer.
- "failed": the step cannot be done. Say why in summary.
Each newTasks item has an id (short, kebab-case), a title, self-contained instructions, and optionally a check (a shell command run from the project root that proves it is done) and dependsOn (ids of other new or existing steps).

End your final message with the report as one JSON object in a \`\`\`json block, matching this schema:
${"```"}json
${JSON.stringify(OUTCOME_SCHEMA)}
${"```"}`;

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
    `Project root: ${wf.root}`,
  ];
  if (data.check) {
    parts.push(
      `When you report done, the workflow runs this exact command from the project root, and the step only counts as done if it passes:\n${indent(data.check, "    ")}\nBefore reporting, run it yourself exactly as written from the project root, and fix what fails.`,
    );
  }

  const deps = wf.graph.dependencyEdges(id);
  if (deps.length) {
    const results = deps.map((edge) => wf.node(edge.dependsOn).data.result ?? "(no summary)");
    const total = results.reduce((sum, r) => sum + r.length, 0);
    const share = total > RESULTS_BUDGET ? Math.max(MIN_SHARE, Math.floor(RESULTS_BUDGET / deps.length)) : Infinity;
    let clipped = false;
    const lines = deps.map((edge, i) => {
      const dep = wf.node(edge.dependsOn);
      const label = edge.data?.label ? ` (${edge.data.label})` : "";
      let result = results[i]!;
      if (result.length > share) {
        result = `${result.slice(0, share)}… [shortened; ${result.length} characters in full]`;
        clipped = true;
      }
      return `- ${dep.id}: ${dep.data.title}${label}\n${indent(result, "    ")}`;
    });
    if (clipped) {
      lines.push(
        `Some summaries are shortened to keep this prompt small. Print one in full with:\n    node -e 'for (const n of require(process.argv[1]).graph.nodes) if (n.id === process.argv[2]) console.log(n.data.result)' ${JSON.stringify(wf.path)} <step-id>`,
      );
    }
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
      return `- [${state}] ${other.id}: ${other.data.title}`;
    });
    parts.push(
      `## Other steps in this workflow\n${lines.join("\n")}\nSteps marked "running now" run at the same time as this one, possibly in the same checkout. Do not change or revert files they own. If a wider build or test run fails only in their files, it is not yours to fix: say so in your summary, and make sure your own part and your check pass.`,
    );
  }

  parts.push(RULES, REPORT);
  return parts.join("\n\n");
}

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAll, projectRoot, questionsText, stateOf } from "./host.ts";
import type { Workflow } from "./workflow.ts";

/**
 * UserPromptSubmit hook: tells the main agent about open questions on every
 * prompt, and once per session about workflows with work left. Prints
 * {"additionalContext": ...} or nothing; never fails the prompt.
 */
async function main(): Promise<void> {
  const input = JSON.parse(await readStdin()) as { cwd?: string; session_id?: string; sessionId?: string };
  if (!input.cwd) return;
  const root = projectRoot(input.cwd);
  const all = await loadAll(root);
  if (!all.length) return;

  const parts: string[] = [];
  const questions = all.flatMap((wf) => wf.questions());
  if (questions.length) {
    parts.push(
      `Dynamic workflow ${questionsText(questions)} If the user's message answers one, pass it to dw_answer (cwd ${root}). Otherwise mention that these questions are open.`,
    );
  }
  const left = all.filter((wf) => !wf.graph.isComplete && (wf.inFlight().length || wf.graph.count("ready")));
  const session = input.session_id ?? input.sessionId;
  if (left.length && session && firstTime(session, root)) {
    const lines = left.map((wf: Workflow) => `- ${wf.id}: ${stateOf(wf)}. ${wf.goal}`);
    parts.push(
      `These dynamic workflows of ${root} have work left:\n${lines.join("\n")}\nMention them to the user. If the user wants to continue one, call dw_run (it requeues steps whose subagents are gone). Never resume without the user asking.`,
    );
  }
  if (parts.length) process.stdout.write(JSON.stringify({ additionalContext: parts.join("\n\n") }));
}

/** True the first time a session asks about a project. */
function firstTime(session: string, root: string): boolean {
  const dir = join(tmpdir(), "dynamic-workflows-hook");
  const key = createHash("sha256").update(`${session}\n${root}`).digest("hex").slice(0, 32);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, key), "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

main().catch(() => {});

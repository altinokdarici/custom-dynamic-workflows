import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { viewHtml } from "./view.ts";
import type { Workflow } from "./workflow.ts";

/** Set by the Agents host: a directory where tools drop canvases for a session to show without the model. */
export const INBOX_ENV = "AGENTS_CANVAS_INBOX";
/** Set by Copilot for its plugin MCP servers: the session this server belongs to. */
export const SESSION_ENV = "COPILOT_AGENT_SESSION_ID";

export function canvasName(wf: Workflow): string {
  return `workflow-${wf.id}`.slice(0, 64);
}

export function canvasTitle(wf: Workflow): string {
  const goal = wf.goal.replace(/\s+/g, " ").trim();
  return goal.length > 80 ? `${goal.slice(0, 79)}…` : goal;
}

/**
 * Shows the workflow's step graph in the Agents side panel by writing it to the host's canvas inbox.
 * Does nothing outside Agents. Never throws: the canvas is a view, not part of the workflow.
 */
export async function publishCanvas(wf: Workflow, state: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const inbox = env[INBOX_ENV];
  const sessionId = env[SESSION_ENV];
  if (!inbox || !sessionId) return false;
  try {
    await mkdir(inbox, { recursive: true, mode: 0o700 });
    const message = { sessionId, name: canvasName(wf), kind: "html", title: canvasTitle(wf), content: viewHtml(wf, state) };
    const file = join(inbox, `${sessionId}-${wf.id}-${Date.now()}-${process.pid}`);
    await writeFile(`${file}.tmp`, JSON.stringify(message), { mode: 0o600 });
    await rename(`${file}.tmp`, `${file}.json`);
    return true;
  } catch {
    return false;
  }
}

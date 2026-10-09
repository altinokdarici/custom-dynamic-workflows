import { GOAL, type Workflow } from "./workflow.ts";

type Status = "done" | "running" | "asking" | "retrying" | "ready" | "waiting";

const LEGEND: [Status, string][] = [
  ["done", "done"],
  ["running", "running"],
  ["retrying", "running again"],
  ["asking", "needs you"],
  ["ready", "ready"],
  ["waiting", "waiting on steps"],
];

const COLORS: Record<Status, string> = {
  done: "#2e7d32",
  running: "#1565c0",
  retrying: "#ef6c00",
  asking: "#c62828",
  ready: "#6a1b9a",
  waiting: "#616161",
};

/** A self-contained HTML page for an Agents canvas: the step graph colored by status, plus open questions. */
export function viewHtml(wf: Workflow, state: string): string {
  const nodes = [...wf.graph.nodes()];
  const key = new Map(nodes.map((n, i) => [n.id, `n${i}`]));
  const lines = ["flowchart TD"];
  for (const [status, color] of Object.entries(COLORS)) {
    lines.push(`  classDef ${status} fill:${color},stroke:${color},color:#fff`);
  }
  for (const node of nodes) {
    const d = node.data;
    const status = statusOf(wf, node);
    const extra = [d.attempts > 1 ? `attempt ${d.attempts}` : "", d.check ? "✓ checked" : ""].filter(Boolean).join(" · ");
    const label = [`<b>${label_(node.id)}</b>`, label_(clip(d.title, 48)), extra].filter(Boolean).join("<br/>");
    lines.push(`  ${key.get(node.id)}["${label}"]:::${status}`);
  }
  for (const node of nodes) {
    for (const edge of wf.graph.dependencyEdges(node.id)) {
      // The goal depends on every step; only edges from the last steps are drawn.
      if (node.id === GOAL && wf.graph.dependentEdges(edge.dependsOn).length > 1) continue;
      const text = edge.data?.label ? `|"${label_(clip(edge.data.label, 30))}"|` : "";
      lines.push(`  ${key.get(edge.dependsOn)} -->${text} ${key.get(node.id)}`);
    }
  }

  const questions = wf.questions().map((q) => `<li><b>${esc(q.nodeId)}</b>: ${esc(q.question)}</li>`);
  const errors = nodes
    .filter((n) => n.state !== "completed" && n.data.lastError && !wf.isWaiting(n))
    .map((n) => `<li><b>${esc(n.id)}</b>: ${esc(clip(n.data.lastError ?? "", 300))}</li>`);
  const legend = LEGEND.map(([s, text]) => `<span><i style="background:${COLORS[s]}"></i>${text}</span>`).join("");
  const done = wf.graph.count("completed");

  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:14px system-ui,sans-serif;margin:12px;color:CanvasText;background:transparent}
:root[data-theme=dark]{color-scheme:dark}:root[data-theme=light]{color-scheme:light}
h3{margin:0 0 4px}p{margin:0 0 8px;opacity:.8}.legend{display:flex;flex-wrap:wrap;gap:10px;font-size:12px;margin-bottom:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px}ul{padding-left:18px}
</style></head><body>
<h3>${esc(wf.goal)}</h3>
<p>${esc(wf.id)} · ${done}/${wf.graph.size} steps done · ${esc(state)}</p>
<div class="legend">${legend}</div>
<pre class="mermaid">${esc(lines.join("\n"))}</pre>
${questions.length ? `<h4>Needs you</h4><ul>${questions.join("")}</ul>` : ""}
${errors.length ? `<h4>Last errors</h4><ul>${errors.join("")}</ul>` : ""}
<script src="/canvas-lib/mermaid.min.js"></script>
<script>mermaid.initialize({startOnLoad:true,securityLevel:"loose",theme:document.documentElement.dataset.theme==="dark"?"dark":"default"});</script>
</body></html>`;
}

function statusOf(wf: Workflow, node: ReturnType<Workflow["node"]>): Status {
  if (node.state === "completed") return "done";
  if (wf.isWaiting(node)) return "asking";
  if (node.state === "in-progress") return node.data.attempts > 1 ? "retrying" : "running";
  if (node.state === "ready") return "ready";
  return "waiting";
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Text inside a quoted Mermaid label: quotes become entities, and markup characters are dropped. */
function label_(text: string): string {
  return text.replace(/"/g, "#quot;").replace(/[<>]/g, "").replace(/\s+/g, " ");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

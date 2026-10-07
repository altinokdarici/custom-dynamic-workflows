import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyChanges, type GraphChange, type GraphStore } from "@altinokdarici/p-graph";
import type { EdgeData, NodeData, WorkflowFile } from "./types.ts";

export const WORKFLOWS_DIR = join(".copilot", "workflows");

/**
 * Keeps one workflow as a JSON document. p-graph hands it every change; the
 * store patches the document in memory and writes it back atomically. Writes
 * are coalesced: a burst of synchronous graph operations becomes one write.
 */
export class FileStore implements GraphStore<NodeData, EdgeData> {
  readonly path: string;
  readonly doc: WorkflowFile;
  #queued = false;
  #writes: Promise<void> = Promise.resolve();

  constructor(path: string, doc: WorkflowFile) {
    this.path = path;
    this.doc = doc;
  }

  apply(changes: readonly GraphChange<NodeData, EdgeData>[]): void {
    applyChanges(this.doc.graph, changes);
    this.touch();
  }

  /** Schedules a write of the current document. */
  touch(): void {
    if (this.#queued) return;
    this.#queued = true;
    // Every write stores the whole document, so only the latest one matters.
    this.#writes = this.#writes
      .catch(() => {})
      .then(() => {
        this.#queued = false;
        return writeJsonAtomic(this.path, this.doc);
      });
  }

  /** Resolves once the document on disk matches memory. */
  flush(): Promise<void> {
    return this.#writes;
  }
}

export function workflowPath(root: string, id: string): string {
  return join(root, WORKFLOWS_DIR, `${id}.json`);
}

/** Reads every workflow document under the project root; unreadable files are reported and skipped. */
export async function loadWorkflowFiles(
  root: string,
  onError: (path: string, error: unknown) => void,
): Promise<{ path: string; doc: WorkflowFile }[]> {
  const dir = join(root, WORKFLOWS_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const path = join(dir, name);
    try {
      const doc = JSON.parse(await readFile(path, "utf8")) as WorkflowFile;
      if (doc.version !== 1 || typeof doc.id !== "string" || !doc.graph) throw new Error("not a workflow file");
      files.push({ path, doc });
    } catch (error) {
      onError(path, error);
    }
  }
  return files;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  // Workflow state is local; keep it out of commits without touching the repo's .gitignore.
  await writeFile(join(dir, ".gitignore"), "*\n", { flag: "wx" }).catch(() => {});
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

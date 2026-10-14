import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const git = promisify(execFile);

/** Where a step works and the git commit its changes are compared against. */
export interface Baseline {
  dir: string;
  commit: string;
}

/** Lines that switch tests off: skip, todo, only and ignore markers of common test runners. */
const SKIP_MARKERS = [
  /\b(?:it|test|describe|context|suite|bench)\.(?:skip|todo|only)\b/,
  /\b(?:xit|xtest|xdescribe|xcontext)\s*\(/,
  /\{\s*(?:skip|todo|only)\s*:\s*true\b/,
  /\bt\.skip\s*\(/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /@unittest\.skip/,
  /\bpytest\.skip\s*\(/,
  /@(?:Disabled|Ignore)\b/,
  /#\[ignore\]/,
  /\bt\.Skip(?:Now|f)?\s*\(/,
];

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|evals?)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/;

/** The directory a check runs in: the project root, or the directory of a leading `cd <dir> &&`. */
export function checkDir(root: string, check: string | undefined): string {
  const cd = check?.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/);
  return cd ? resolve(root, cd[1]!.replace(/^["']|["']$/g, "")) : root;
}

async function gitOut(dir: string, args: string[]): Promise<string> {
  const { stdout } = await git("git", args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Records the state a step starts from: the working tree of its check's
 * directory (`git stash create` snapshots it without touching anything), or
 * the project's HEAD when that directory doesn't exist yet, such as a
 * worktree the step creates. Undefined outside a git repository.
 */
export async function takeBaseline(root: string, check: string | undefined): Promise<Baseline | undefined> {
  const dir = checkDir(root, check);
  const from = existsSync(dir) ? dir : root;
  try {
    const head = (await gitOut(from, ["rev-parse", "HEAD"])).trim();
    const snapshot = from === dir ? (await gitOut(dir, ["stash", "create"]).catch(() => "")).trim() : "";
    return { dir, commit: snapshot || head };
  } catch {
    return undefined;
  }
}

/**
 * Changes since `baseline` that can make a check pass without doing the work:
 * skip markers added, test files deleted, files a check names changed, and
 * npm scripts a check runs changed. Returns one line per finding.
 */
export async function findWeakening(baseline: Baseline, checks: (string | undefined)[]): Promise<string[]> {
  const { dir, commit } = baseline;
  if (!existsSync(dir)) return [];
  let status: string;
  let patch: string;
  try {
    status = await gitOut(dir, ["diff", "--no-renames", "--name-status", commit, "--", "."]);
    patch = await gitOut(dir, ["diff", "--no-renames", "--no-color", "--no-ext-diff", "-U0", commit, "--", "."]);
  } catch {
    return [];
  }
  const findings: string[] = [];
  const changed = new Map<string, string>();
  for (const line of status.split("\n")) {
    const [kind, path] = line.split("\t");
    if (kind && path) changed.set(path, kind);
  }

  for (const [path, kind] of changed) {
    if (kind === "D" && TEST_PATH.test(path)) findings.push(`deleted test file ${path}`);
  }

  let file = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) file = line.replace(/^\+\+\+ (b\/)?/, "");
    else if (line.startsWith("+") && SKIP_MARKERS.some((marker) => marker.test(line))) {
      findings.push(`added a test skip marker in ${file}: ${clip(line.slice(1).trim())}`);
    }
  }

  const named = new Set<string>();
  const scripts = new Set<string>();
  for (const check of checks) {
    if (!check) continue;
    for (const path of namedPaths(check)) named.add(path);
    for (const script of npmScripts(check)) scripts.add(script);
  }
  for (const path of named) {
    const kind = changed.get(path);
    if (kind === "M" || kind === "D" || kind === "T") findings.push(`${kind === "D" ? "deleted" : "changed"} ${path}, which a check runs`);
  }
  if (scripts.size && changed.get("package.json") === "M") {
    const before = await gitOut(dir, ["show", `${commit}:./package.json`]).then(scriptsOf, () => ({}) as Record<string, string>);
    const after = await readFile(join(dir, "package.json"), "utf8").then(scriptsOf, () => ({}) as Record<string, string>);
    for (const script of scripts) {
      if (before[script] !== after[script]) findings.push(`changed the npm script "${script}", which a check runs`);
    }
  }
  return findings;
}

/** Relative file paths a check command mentions, after any leading `cd <dir> &&`. */
function namedPaths(check: string): string[] {
  const command = check.replace(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/, "");
  return command
    .split(/[\s;&|()<>]+/)
    .map((token) => token.replace(/^["']|["']$/g, "").replace(/^\.\//, ""))
    .filter((token) => /^[\w.@-][\w./@-]*\.[A-Za-z0-9]+$/.test(token) && !token.startsWith("-") && !/^\d/.test(token));
}

const PACKAGE_MANAGER_COMMANDS = new Set(["install", "i", "add", "remove", "ci", "exec", "dlx", "x", "create", "why", "list"]);

/** npm scripts a command runs: `npm test`, `npm run x`, `pnpm x`, `yarn run x`. */
function npmScripts(check: string): string[] {
  const found: string[] = [];
  for (const [, short, named] of check.matchAll(/\bnpm\s+(?:(test|t|start)\b|run(?:-script)?\s+([\w:.-]+))/g)) {
    found.push(named ?? (short === "t" ? "test" : short!));
  }
  for (const [, name] of check.matchAll(/\b(?:pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)/g)) {
    if (!PACKAGE_MANAGER_COMMANDS.has(name!)) found.push(name!);
  }
  return found;
}

function scriptsOf(text: string): Record<string, string> {
  try {
    const scripts = JSON.parse(text)?.scripts;
    return scripts && typeof scripts === "object" ? scripts : {};
  } catch {
    return {};
  }
}

function clip(text: string, max = 160): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

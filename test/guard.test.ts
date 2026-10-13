import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { checkDir, findWeakening, takeBaseline } from "../src/guard.ts";
import { tempRoot } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString();

async function repo(t: import("node:test").TestContext): Promise<string> {
  const root = await tempRoot(t);
  git(root, "init", "-q", "-b", "main");
  await mkdir(join(root, "test"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "test/a.test.ts"), 'test("adds", () => {});\n');
  await writeFile(join(root, "test/b.test.ts"), 'test("subtracts", () => {});\n');
  await writeFile(join(root, "scripts/evals.mjs"), "process.exit(run());\n");
  await writeFile(join(root, "src.ts"), "export const x = 1;\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return root;
}

test("changes that let a check pass without the work are found; ordinary work is not", async (t) => {
  const root = await repo(t);
  const baseline = (await takeBaseline(root, "npm test"))!;
  assert.equal(baseline.dir, root);

  await writeFile(join(root, "src.ts"), "export const x = 2;\n");
  await writeFile(join(root, "test/c.test.ts"), 'test("new", () => {});\n');
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "true" } }));
  assert.deepEqual(await findWeakening(baseline, ["npm test", undefined]), [], "Source edits, new tests and other scripts are fine.");

  await writeFile(join(root, "test/a.test.ts"), 'test.skip("adds", () => {});\n');
  await rm(join(root, "test/b.test.ts"));
  await writeFile(join(root, "scripts/evals.mjs"), "process.exit(0);\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "true", build: "tsc" } }));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "cut corners");

  const found = await findWeakening(baseline, ["node scripts/evals.mjs foo", "npm test"]);
  assert.deepEqual(found, [
    "deleted test file test/b.test.ts",
    'added a test skip marker in test/a.test.ts: test.skip("adds", () => {});',
    "changed scripts/evals.mjs, which a check runs",
    'changed the npm script "test", which a check runs',
  ]);
});

test("uncommitted changes from before the step started are part of its baseline", async (t) => {
  const root = await repo(t);
  await writeFile(join(root, "test/a.test.ts"), 'test.skip("adds", () => {});\n');
  const baseline = (await takeBaseline(root, undefined))!;
  assert.deepEqual(await findWeakening(baseline, []), []);
  git(root, "status", "--short");
  assert.match(git(root, "status", "--short"), /test\/a\.test\.ts/, "Taking the baseline leaves the working tree alone.");
});

test("a step working in a worktree it creates is compared with the project's HEAD", async (t) => {
  const root = await repo(t);
  const check = "cd .worktrees/fix && npm test";
  assert.equal(checkDir(root, check), join(root, ".worktrees/fix"));
  const baseline = (await takeBaseline(root, check))!;
  git(root, "worktree", "add", "-q", ".worktrees/fix", "-b", "fix");
  const tree = join(root, ".worktrees/fix");
  await writeFile(join(tree, "test/a.test.ts"), 'it.only("adds", () => {});\n');
  assert.deepEqual(await findWeakening(baseline, [check]), [
    'added a test skip marker in test/a.test.ts: it.only("adds", () => {});',
  ]);
});

test("outside a git repository there is no baseline", async (t) => {
  assert.equal(await takeBaseline(await tempRoot(t), "npm test"), undefined);
});

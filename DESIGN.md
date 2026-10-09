# custom-dynamic-workflows: Design

Status: v1 (plugin 0.2: MCP server, hook and skill), built and tried. Owner: Altinok Darici.

v1 is deliberately small. It replaces the larger v2 design; §12 lists what was cut and why.

## 1. Goal

Take a task the user describes in plain language and split it into a graph of stage-sized steps. Run every step to completion, including work found along the way and decisions only the user can make.

Non-goals: a YAML/DSL, a general job scheduler, cross-machine execution, and recurring or endless loops such as "watch CI forever". Every workflow is finite.

### What "guaranteed" means

No code can make an impossible task finish or an absent user answer. What the plugin guarantees:

1. **Nothing accepted is lost.** A step written to the graph stays there until it completes. No tool or report removes or skips a step.
2. **No false success.** A step completes only when its agent reports `done` and its `check`, if it has one, exits 0. The workflow is done only when every node is complete. That includes the final `goal` step, which runs last and checks the goal against the repository.
3. **Always resumable.** All state is in one JSON file, written atomically after every change. After a crash, `dw_run` puts interrupted steps back in the queue and tells their next attempt that they were interrupted.

> **Code owns control flow. The model owns content.** Agents decide how to do a step and report what work they found. Code decides when a step is done, what runs next and when to ask the user.

## 2. Pieces

| Piece | Role |
| --- | --- |
| [p-graph](https://github.com/altinokdarici/p-graph) | Dynamic priority graph with edge data. Holds node state (pending, ready, in-progress, completed) and readiness, and hands every change to a store. |
| MCP server `dynamic-workflows` (stdio) | The `dw_*` tools. Owns the graph, the rules and the checks. Hands steps out to the main agent and takes their reports back. |
| `UserPromptSubmit` hook | On every prompt: open questions. Once per session: workflows with work left. |
| Skill `dynamic-workflow` | Tells the main agent how to plan (stage-sized steps, checks, dependencies, worktrees, concurrency) and how to run the steps as subagents. |

```
.claude-plugin/plugin.json   name, version, "skills": "skills/"
.mcp.json                    node ${CLAUDE_PLUGIN_ROOT}/dist/mcp.mjs
hooks/hooks.json             UserPromptSubmit: node ${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs
dist/mcp.mjs, dist/hook.mjs  bundles of src/, p-graph and the MCP SDK
skills/dynamic-workflow/SKILL.md
src/workflow.ts   graph rules: adding steps, applying reports, retry-or-ask, answers, recovery
src/prompt.ts     the step prompt and the report schema
src/host.ts       tool handlers: load, hand out steps, run checks, apply reports, save
src/mcp.ts        the MCP server: tool schemas and descriptions
src/hook.ts       the prompt hook
src/store.ts, src/check.ts, src/parse.ts, src/text.ts, src/types.ts
```

**Why not an extension.** Version 0.1 was a Copilot CLI extension: a background SDK workflow (`session.workflow`, `ctx.agent`) ran the steps, so the main agent only planned. Agents-app sessions run `copilot --acp`, which never loads extensions (tried on 1.0.88 and 1.0.95, with the `EXTENSIONS` feature flag, and with both plugin layouts). ACP does load plugin skills, MCP servers and hooks, which is all cognee-style plugins use. So 0.2 keeps the rules and checks in an MCP server and has the main agent launch the subagents. The trade-off: the main agent spends a short turn on every finished step, and the run lives as long as its session.

## 3. The graph

### Nodes and edges

```ts
interface NodeSpec {          // written by the planner (dw_plan, dw_add_task) or by a step's report
  title: string;
  instructions: string;       // self-contained: the step's agent sees little else
  check?: string;             // shell command the server runs from the project root; exit 0 means done
}

interface NodeData extends NodeSpec {  // the rest is written only by the server
  attempts: number;
  lastError?: string;         // why the previous attempt didn't count; shown to the next one
  result?: string;            // the summary of the done report; shown to dependent steps
  question?: string;          // set while the step waits for the user
  answer?: string;
  lastRequested?: string[];   // goal only: the work its last report asked for
  history?: string[];         // every answer, and check changes made with them
}

interface EdgeData { label: string }   // optional: why one step waits for another
```

There is one node type and no `kind` field. A question is state on the step that asked it, not a separate node.

Edge labels come from three places:

- the planner: `dependsOn: [{ "id": "...", "label": "why" }]`;
- `found by <id>`: work a finished step discovered;
- `needed first`: prerequisites a blocked step asked for.

A step's prompt shows the labels next to the results of the steps it waited for.

### The goal step

Every workflow gets a node with the id `goal`. It depends on every other step. A step added later also becomes one of its prerequisites, as long as the goal step hasn't started.

A step added while the goal step is running (for example by a tool call) can't become a prerequisite of a run already in progress. When the goal step finishes, the server sees the unfinished steps, makes them prerequisites and runs the goal step again after them, so the goal is never declared done while work is left.

Its agent checks the goal against the actual files, branches and command output instead of trusting the summaries. It also runs `goalCheck` if the planner gave one. If something is missing, it reports `blocked` with new steps; a `done` report that still lists new steps counts as `blocked`. Its priority is the lowest possible, so p-graph's priority inheritance never raises other steps through it.

**Convergence.** The server remembers the titles (normalised: case and whitespace) of the work the goal step last asked for. If the next goal report asks for the same work again, the new steps are not added; the goal step asks the user how to continue instead (§6). A report that asks for different work resets the comparison, so a goal step that finds new gaps each time still has no round limit.

### Ids and priority

- Ids are slugged (`"Fix README links!"` becomes `fix-readme-links`), and `goal` is reserved.
- `dw_plan` ids must be unique. In later batches (`dw_add_task`, reports), an id that's taken gets a `-2`, `-3`… suffix.
- `dependsOn` refers to ids in the same batch first, then to existing steps.
- Priority defaults to 0. Ready steps run highest first, and p-graph's `inheritPriority` raises a step's prerequisites to its priority.

### Stages, not steps

A step is a workflow **stage**: something you'd hand to a person as one assignment, such as "migrate the code-review skill on its own branch" or "fix the review findings". It is never a single command. The step's agent does the sub-steps itself and tracks them in its own todo list, which never reaches the graph.

There are no numeric caps. The skill and the report instructions keep plans at stage level:

- The skill asks for one item, package or concern per step. It rules out one step per command, and one step for everything.
- If the user names the stages, the planner uses them as given.
- The report format tells agents to add `newTasks` only for work *outside* their step.
- Fix loops grow the graph by stages. A review step that finds problems reports `done` with fix steps as `newTasks`, and whatever waited for the review also waits for the fixes.

### Checks

`check` lets code, not the model, decide when a step is done. When a step reports `done`, the server runs the check in a shell, from the project root:

- Exit 0: the step completes.
- Any other exit code: the attempt fails with the command's output (the last 12k characters), and the step runs again with that output in its prompt (see §4).

The step's prompt shows the check and asks the agent to run it before reporting, so most failures get fixed within the attempt. The server's run is the gate.

Checks run with `CI=true` in their environment, so test runners such as `node --test`, vitest and jest run once instead of starting watch mode. They run in their own process group, so cancelling a run kills everything a check started. If the step's directory doesn't exist, the check fails with a message that says so.

## 4. Reports

Every step ends its final message with a report: one JSON object, usually in a ```` ```json ```` block. The step prompt shows its JSON Schema, and `parseOutcome` enforces it. It takes the whole message as JSON if it can, else its last json code block, else the text from the first `{` to the last `}`.

```ts
{
  status: "done" | "blocked" | "needs_user" | "failed",
  summary: string,          // what was done, and what later steps need to know
  question?: string,        // for needs_user
  newTasks?: { id, title, instructions, check?, dependsOn?: string[] }[]
}
```

| Report | What `dw_report` does |
| --- | --- |
| `done` | Runs the check. If it passes: adds `newTasks`, makes every step that waited for this one also wait for them (`found by <id>`), stores `summary` as the result and completes the step. If it fails: retry or ask (below). |
| `blocked` with `newTasks` | Adds the new steps, puts the step back in the queue and makes it wait for them (`needed first`). |
| `needs_user` with a `question` | Stores the question; the step waits for the user (§6). |
| `failed` | Asks the user right away, giving the agent's reason. The agent has already decided it can't continue, so a blind retry would waste a run. |
| No report, an invalid report, `blocked` without `newTasks`, or `needs_user` without a question | Retry or ask. |

**Retry or ask.** A failed attempt stores its error in `lastError`, and the step runs again with it. If the next attempt fails *the same way*, the step asks the user instead. Two errors count as the same when they match after removing ANSI colors, numbers (line numbers, timings, PIDs) and whitespace differences. There's no retry count: a step keeps retrying while each failure is new, because a new failure means it's getting somewhere.

**Atomic changes.** Every change (a plan, a report or an added step) first runs on a scratch copy of the graph, built with `PriorityGraph.fromSnapshot` from a clone. If it throws (because of a cycle, an unknown dependency or a duplicate id), the live graph is untouched: a tool call returns the error, and a step retries with it. Otherwise the change is applied to the live graph synchronously, so steps running in parallel never see half a report.

## 5. Running

**Stateless calls.** One MCP server serves every session of a CLI process, and it starts in the plugin directory with no MCP roots. So every tool takes `cwd`, the main agent's working directory, and the project is its git top level. Every call reads the workflow from disk, changes it, and writes it back before it returns. No session ever acts on an old copy, and any session can pick up any workflow. Calls for one project run one at a time.

**Handing out steps.** Every tool that changes a workflow (`dw_plan`, `dw_report`, `dw_answer`, `dw_add_task`, `dw_run`) ends by handing out ready steps, in priority order, until `concurrency` steps are in flight. A step in flight is in progress and not waiting for the user. Each hand-out counts an attempt and comes with the step's full prompt. The reply tells the main agent what to do next:

- launch each handed-out step as a background `task` subagent, with its prompt as written;
- the steps whose reports are still expected;
- the open questions, with the instruction never to answer for the user;
- or that the workflow is done, with every answer and check change.

`dw_next` gives the same reply without changing anything.

**Reports.** When a subagent finishes, the main agent passes its final message to `dw_report` with the step id and attempt number. The call:

1. rejects a report for an attempt that is not in flight (an old attempt after `dw_run`, or a step that already reported);
2. parses the report and, if it would complete the step, takes the step's check;
3. runs the check outside the per-project queue, so a slow check doesn't hold up other reports;
4. re-reads the workflow, checks the attempt again, applies the report, and hands out the next steps.

**Resuming.** Nothing runs without the main agent. If its session ends, steps stay in flight. `dw_run` requeues them with `lastError` saying the previous attempt was interrupted and may have done part of the work; the new attempt number makes any late report from the old subagent bounce. Workflows never resume on their own. On the first prompt of a session, the hook tells the main agent which workflows of the project have work left, so it can offer `dw_run`.

Two live sessions can drive the same workflow. They share the concurrency, but `dw_run` in one requeues the other's steps; the skill says not to use `dw_run` while subagents still run.

**Step prompt.** Built fresh for each attempt, it contains:

- the goal;
- the step and its attempt number, or the goal-check instructions;
- the project root and the check;
- the steps it waited for, with their labels and results;
- the previous attempt's error;
- the question and answer;
- the other steps, marking the ones running now;
- the rules: do only this step, don't call `dw_*` tools or edit the workflow file, and never weaken checks or tests;
- the report format.

## 6. Questions

A step asks the user when it reports `needs_user`, reports `failed`, or fails the same way twice. The question is stored on the step, which stays in progress and is marked as waiting. Other steps keep running.

- The `dw_report` reply lists the question and tells the main agent to ask the user (with `ask_user` when it has it) and never to answer for them.
- On every user message, the hook adds the open questions to the main agent's context.
- The main agent passes the user's answer to `dw_answer`. The step then runs again with the question and answer in its prompt.
- When the question comes from a wrong check, `dw_answer` can replace the step's check too. The old check's failure is dropped with it. The goal check can't be replaced.

Visibility, not enforcement. The main agent can call `dw_answer` without asking the user; in the dogfood run (§11) it did. Rather than try to stop that, every answer and check change is:

- flagged with ⚠ in the `dw_answer` reply when the check changed, which tells the main agent to tell the user;
- kept in the step's `history`;
- listed in `dw_status` and in the reply that finishes the workflow.

The goal check is the backstop: a weakened step check still has to get past it.

## 7. Parallelism

The main agent chooses `concurrency` when it plans, based on how independent the steps are. Steps that run together must not edit the same files or switch branches in the same checkout.

For one branch per item, the skill says to either create a git worktree per item and say in each step's instructions to work there, or use concurrency 1. Checks run from the repo root and `cd` into the worktree themselves: there is exactly one way to say where a check runs. Each step's prompt lists the steps running at the same time and tells the agent not to change their files. `dw_run` can change the concurrency later.

There is no default cap. The AI decides on parallelism, and checks and the goal step are the safety net, not a low limit.

## 8. State

There's one file per workflow: `.copilot/workflows/<id>.json` in the project. The directory gets its own `.gitignore` containing `*`. Workflow state never ends up in commits, and the repository's own `.gitignore` is left alone.

```ts
{ version: 1, id, goal, concurrency, createdAt, graph /* p-graph snapshot */ }
```

- The workflow id is the slugged goal (up to 32 characters) plus four hex characters.
- `FileStore` implements p-graph's `GraphStore`. p-graph hands it each batch of changes; the store applies them to the document with `applyChanges` and schedules a write.
- Writes are coalesced (one write for a burst of changes) and atomic (a temp file, then a rename).
- Unreadable files are skipped with a warning.

## 9. Tools

Every tool also takes `cwd`.

| Tool | Purpose |
| --- | --- |
| `dw_plan(goal, concurrency, tasks, goalCheck?)` | Create a workflow and hand out its first steps. Bad plans (duplicate ids, unknown dependencies, cycles) are rejected before anything is saved. |
| `dw_report(workflowId, stepId, attempt, report)` | Apply a finished subagent's report: parse, run the check, apply, hand out the next steps. |
| `dw_next(workflowId)` | What to do next, without changing anything. |
| `dw_answer(workflowId, nodeId, answer, check?)` | Give a waiting step the user's answer, optionally replacing its check (not the goal's); the step is handed out again. |
| `dw_add_task(workflowId, task, blocks?)` | Add a step. `blocks` lists steps that haven't started and must wait for it. |
| `dw_run(workflowId, concurrency?)` | Requeue steps whose subagent is gone and hand them out again, optionally with a new concurrency. |
| `dw_status(workflowId?)` | Show steps, results, errors and questions; with no id, list the project's workflows. |
| `dw_view(workflowId)` | A self-contained HTML page (Mermaid graph colored by status, open questions, last errors) for an Agents canvas. The skill passes it to `canvas_show` after each tool call that changes the graph, so the side panel stays live. It costs about 1k tokens per update. |

- Errors go back to the model as MCP tool errors that say what to fix.
- There is no tool to remove a step, remove a dependency or complete a step, because each of those could silently drop work.

## 10. What code enforces, and what it trusts

The concern: could the AI change the graph to cut corners and skip work?

Code enforces:

- A step completes only through a `done` report for its current attempt and a passing check, run by the server.
- The goal check command can't be changed after planning.
- The workflow is done only when every node is complete, including the goal step.
- A report can only add work: new steps, and new waits for its own step or for the steps that waited for it. It can't remove, complete or edit other steps.
- Nothing removes a step once it's in the graph.

Code trusts the model for the following. The goal step re-checks the result.

- Running each step as its own subagent and passing its report on unchanged. The main agent could write a report itself; the check still runs, and the skill and every reply forbid it.
- The plan. The main agent writes the steps and their checks, and a weak check is a weak gate.
- Not weakening tests or checks. The step prompt forbids it.
- Not editing `.copilot/workflows/` or calling `dw_*` tools from a step. The prompt forbids it, but nothing technically prevents it. An edit made during a run is overwritten by the next write.
- Asking the user before `dw_answer`, especially before replacing a check. Code doesn't enforce it; it shows every answer and check change to the user (§6).

## 11. Tried it

**Unit tests.** 24 tests use `node --test` with a fake agent and fake checks. A helper plays the main agent: it reads the hand-outs from the reply text, runs the fake agent, and calls `dw_report`. They cover:

- the concurrency pool and dependency order;
- a failing check retried with its output, and the same failure twice turning into a question;
- `needs_user` with answers, `blocked`, discovered work, and the goal step adding work;
- the goal step asking for the same work twice, and steps added while it runs;
- a report that would create a cycle being rejected without changes;
- crash recovery from the saved file;
- bad plans, added-step ids, steps added while the goal runs, and the check runner with `CI=true`;
- answers that replace a check (and the goal check refusing);
- hand-outs up to the concurrency, reports rejected for an old attempt, reports without JSON, a slow check not blocking other calls, and `cwd` handling.

**Agents-app mode (0.2).** Copilot CLI 1.0.95 in `--acp` mode, as the Agents app runs it, with `--plugin-dir`. Two steps at concurrency 2, one with a wrong check (`grep -q WORLD` for a lowercase file). The MCP tools and the skill loaded. The main agent launched both steps as background subagents and reported each final message. `hello` passed its check. The `world` subagent saw the contradiction and reported `needs_user`, and the main agent put the question to the user without answering it. The user said to change the check; `dw_answer` replaced it with the ⚠ flag, attempt 2 passed, the goal step passed, and the main agent told the user about the check change. It took about 1 minute of run time.

**Real runs with 0.1 (the extension).** The first four used Copilot CLI 1.0.93 with `--plugin-dir`, non-interactive (`-p`).

| Trial | What happened |
| --- | --- |
| Load | The extension and the skill loaded from the plugin directory. The tools found the project root from the session directory. |
| Questions (three small steps) | Two steps ran in parallel. One reported `failed`, refusing to write under `/tmp`, and that became a question. The pass ended `waiting`, and the main agent got the notification. |
| Migration (a sandbox repo with three skills and one agent in `.claude/`, one branch each, `npm run evals -- <name>` as the check, one item broken on purpose) | The main agent read the repo, created four worktrees and planned four steps at concurrency 4, which took 3.7 minutes. The run took 2 minutes and 5 subagents. Every check passed on the first attempt, including the broken item, which its agent fixed. |
| Retry and crash | A check rigged to fail on its first run by the driver sent `alpha` back with the check's output. Attempt 2 verified the existing commit and passed without duplicating it. The CLI was then killed with SIGKILL while `beta` was running. In a new session, `dw_status` showed the workflow as paused, and `dw_run` requeued `beta` with the interruption note. `beta` checked for leftover work, finished, and the goal step passed. |

**Dogfood run.** The plugin fixed five of its own limitations in this repository: goal convergence, steps added while the goal runs, the paused-workflow hint, the run lock, and `CI=true` for checks. Each fix got its own branch and worktree, and everything was merged into the local main branch. This ran in an SDK session (`@github/copilot-sdk` 1.0.17 with the bundled 1.0.93 runtime, `requestExtensions`). The session stayed alive between turns, and every permission request was approved and logged.

- The main agent planned 8 steps at concurrency 5: a worktree setup step, the five fixes, and a merge-and-docs step. Planning took 27 seconds.
- The five fixes ran in parallel, and each reported done after 15 to 30 seconds. Every check then failed twice with the same output. The planner had set each step's `cwd` to its worktree and also started each check with `cd ../cdw-worktrees/<name>`, so the path was doubled. The step agents had run their checks from the repo root, where they passed.
- The pass ended `waiting` with five questions. The completion notification woke the idle session with no user prompt.
- The main agent answered all five questions itself. It created a symlink that made the doubled path exist, then called `dw_answer` five times without asking the user. After that, the fixes, the merge and the goal check passed.
- The run took 3.6 minutes and 18 subagent runs, 10 of which came from the broken checks. It cost about 124 AI credits. The subagents made 81 model calls with 2.8 M input tokens, 94% of them cache reads; each started with about 30k tokens of context. It made 68 permission requests, 63 of them from step subagents' shell commands.
- Review afterwards found that the lock fix still let a second process act on its old copy of a workflow. That process re-ran finished steps and overwrote the other process's results.
- Then we simplified. The lock was removed; re-reading alone fixes the old-copy bug (§5). `cwd` was removed, so a check can't say its directory twice. `dw_answer` can replace a wrong check, in the open (§6).

What the runs taught:

- Agents run their check before reporting, as the prompt asks, so the driver rarely needs to retry. The retry path needed a rigged check to show up.
- `failed` asks the user at once. In the questions trial, that turned a spurious refusal into a question. We kept it: an agent that says it can't continue shouldn't be retried blindly, and the user can answer "try again".
- In the migration trial, the main agent set up the worktrees itself; in the dogfood run, it planned a setup step.
- An interrupted attempt originally gave the next attempt no hint. Recovery now records that the step was interrupted.
- "Only the user answers questions" was a prompt rule, and the main agent broke it when the questions came from its own mistake. Trying to enforce it in code got complicated fast. Showing every answer and check change is simple, and keeps the user informed.
- A wrong check couldn't be fixed from inside a run: it failed the same way every time. Two ways to say where a check runs (`cwd` and a `cd` in the command) caused it.
- Step subagents ask for permissions as the main agent does. An interactive run needs the tools allowed up front, or the user gets one prompt per shell command.

## 12. Limitations and deferred work

Limitations:

- The main agent drives the run: a short turn per finished step, and the run stops when its session ends (`dw_run` resumes).
- Two live sessions can drive one workflow; `dw_run` in one requeues the other's steps.
- The main agent could write a step's report itself instead of running a subagent. The check and goal step still apply.
- The main agent can answer a step's question, or replace its check, without asking the user. The user sees every change, but nothing prevents it.
- Step subagents' permission requests reach the session like the main agent's own, one per shell command.
- Checks have no timeout.
- A goal step that keeps finding different work has no round limit; only a repeated request asks the user.
- Workflows don't resume on their own in a new session; the hook only mentions them.
- Steps run at least once: an interrupted step runs again, so instructions should be safe to repeat.

Changes from the v2 design:

| v2 | v1 | Why |
| --- | --- | --- |
| Node kinds `task`, `ask` and `goal-check` | One node type. Questions live on the step, and the goal is a node with a reserved id. | Fewer moving parts. The step runs again with the answer in its own context. |
| `stage`, `acceptance` and `parent` fields | `instructions` and `check`. The stage guidance lives in the skill. | A check is a stronger definition of done than an acceptance sentence. |
| Edges without labels | Labelled edges (p-graph edge data) | The label tells a step why it waited, for example `found by review`. |
| Concurrency 1 by default, no worktrees | The AI chooses concurrency; worktrees named in instructions and checks | The owner's call: let the AI parallelize, with checks as the guard. |
| Whole-snapshot writes and a `.bak` file | p-graph `GraphStore` change batches and atomic writes | p-graph gained a store interface. |
| Lockfile, owner session and auto-start on session start | No lock and no owner; workflows a session isn't running are re-read before every use; an explicit `dw_run` (the first prompt mentions paused workflows) | Re-reading prevents acting on an old copy. A lock cost more than it was worth. |
| Retry once on failure, then ask | Retry while failures differ; `failed` asks at once | No arbitrary counts. |
| Driver-generated ids (`parent.n`) | Planner ids, slugged, with a suffix on collision | Readable ids in status and prompts. |
| `dw_add_dependency` and `dw_start` | `blocks` on `dw_add_task`; `dw_plan` starts and `dw_run` resumes | Fewer tools. |

Also parked:

- splitting p-graph into graph data and a replaceable runner;
- a priority tool;
- a session executor;
- a hard round limit for the goal step (only repeated requests ask the user today);
- a guard against two live sessions running one workflow, if that turns out to happen in practice.

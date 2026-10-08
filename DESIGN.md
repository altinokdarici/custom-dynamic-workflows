# custom-dynamic-workflows: Design

Status: v1, built and tried. Owner: Altinok Darici.

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
| Copilot CLI extension (`@github/copilot-sdk/extension`) | A process joined to the session. Registers the `dw_*` tools and a prompt hook. |
| SDK dynamic workflow `dw-drive` | One pass over a workflow. Runs steps as subagents with `ctx.agent` and a report schema. |
| Skill `dynamic-workflow` | Tells the main agent how to plan: stage-sized steps, checks, dependencies, worktrees and concurrency. |

```
.claude-plugin/plugin.json                  { "extensions": "extensions/", "skills": "skills/" }
extensions/dynamic-workflows/extension.mjs  bundle of src/ and p-graph (the SDK stays external)
skills/dynamic-workflow/SKILL.md
src/workflow.ts   graph rules: adding steps, applying reports, retry-or-ask, answers, recovery
src/driver.ts     one pass: the concurrency pool and running a step
src/prompt.ts     the step prompt and the report schema
src/host.ts       workflow registry and tool handlers: re-reads, takes the run lock, restarts passes
src/lock.ts       the per-workflow run lock
src/extension.ts  SDK glue: joinSession, dw-drive, tools, hook
src/store.ts, src/check.ts, src/parse.ts, src/text.ts, src/types.ts
```

## 3. The graph

### Nodes and edges

```ts
interface NodeSpec {          // written by the planner (dw_plan, dw_add_task) or by a step's report
  title: string;
  instructions: string;       // self-contained: the step's agent sees little else
  check?: string;             // shell command the driver runs; exit 0 means done
  cwd?: string;               // relative to the project root, for example a git worktree
}

interface NodeData extends NodeSpec {  // the rest is written only by the driver
  attempts: number;
  lastError?: string;         // why the previous attempt didn't count; shown to the next one
  result?: string;            // the summary of the done report; shown to dependent steps
  question?: string;          // set while the step waits for the user
  answer?: string;
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

A step added while the goal step is running (for example by a tool call) can't become a prerequisite of a run already in progress. When the goal step finishes, the driver sees the unfinished steps, makes them prerequisites and runs the goal step again after them, so the goal is never declared done while work is left.

Its agent checks the goal against the actual files, branches and command output instead of trusting the summaries. It also runs `goalCheck` if the planner gave one. If something is missing, it reports `blocked` with new steps; a `done` report that still lists new steps counts as `blocked`. Its priority is the lowest possible, so p-graph's priority inheritance never raises other steps through it.

**Convergence.** The driver remembers the titles (normalised: case and whitespace) of the work the goal step last asked for. If the next goal report asks for the same work again, the new steps are not added; the goal step asks the user how to continue instead (§6). A report that asks for different work resets the comparison, so a goal step that finds new gaps each time still has no round limit.

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

`check` lets code, not the model, decide when a step is done. When a step reports `done`, the driver runs the check in a shell, in the step's directory:

- Exit 0: the step completes.
- Any other exit code: the attempt fails with the command's output (the last 12k characters), and the step runs again with that output in its prompt (see §4).

The step's prompt shows the check and asks the agent to run it before reporting, so most failures get fixed within the attempt. The driver's run is the gate.

Checks run with `CI=true` in their environment, so test runners such as `node --test`, vitest and jest run once instead of starting watch mode. They run in their own process group, so cancelling a run kills everything a check started. If the step's directory doesn't exist, the check fails with a message that says so.

## 4. Reports

Every step ends with a report. The schema passed to `ctx.agent` enforces its shape:

```ts
{
  status: "done" | "blocked" | "needs_user" | "failed",
  summary: string,          // what was done, and what later steps need to know
  question?: string,        // for needs_user
  newTasks?: { id, title, instructions, check?, cwd?, dependsOn?: string[] }[]
}
```

| Report | What the driver does |
| --- | --- |
| `done` | Runs the check. If it passes: adds `newTasks`, makes every step that waited for this one also wait for them (`found by <id>`), stores `summary` as the result and completes the step. If it fails: retry or ask (below). |
| `blocked` with `newTasks` | Adds the new steps, puts the step back in the queue and makes it wait for them (`needed first`). |
| `needs_user` with a `question` | Stores the question; the step waits for the user (§6). |
| `failed` | Asks the user right away, giving the agent's reason. The agent has already decided it can't continue, so a blind retry would waste a run. |
| No report, an invalid report, `blocked` without `newTasks`, or `needs_user` without a question | Retry or ask. |

**Retry or ask.** A failed attempt stores its error in `lastError`, and the step runs again with it. If the next attempt fails *the same way*, the step asks the user instead. Two errors count as the same when they match after removing ANSI colors, numbers (line numbers, timings, PIDs) and whitespace differences. There's no retry count: a step keeps retrying while each failure is new, because a new failure means it's getting somewhere.

**Atomic changes.** Every change (a plan, a report or an added step) first runs on a scratch copy of the graph, built with `PriorityGraph.fromSnapshot` from a clone. If it throws (because of a cycle, an unknown dependency or a duplicate id), the live graph is untouched: a tool call returns the error, and a step retries with it. Otherwise the change is applied to the live graph synchronously, so steps running in parallel never see half a report.

## 5. Running

**Host.** The extension keeps one `Host` for the session. It holds:

- the project's workflows, where the project is the git top level of the session directory;
- at most one active run per workflow;
- the tool handlers.

Workflow files are read again on every tool call and prompt, except those a pass of this process drives, which are current in memory. Another process may have changed the others. They never start on their own; `dw_run` resumes them. On the first prompt of a session, the extension tells the main agent which workflows of the project are paused with work left, so it can offer `dw_run`. It never resumes them itself, and it doesn't call a workflow paused when another live process is driving it.

**Run lock.** A process runs or changes a workflow only while it holds `.copilot/workflows/<id>.lock` (`{ pid, host }`, created atomically), and it reads the file again right after taking the lock, so it never acts on an old copy. While another live process holds the lock:

- `dw_run`, `dw_add_task`, `dw_answer` and the plan's auto-start refuse to touch the workflow, with a message naming the owner and the lock file;
- `dw_status` shows the workflow as running in that process;
- the prompt hint leaves out its questions, which are answered in the process that drives it.

A lock whose owner is a dead process on this host is taken over. A lock from another host, or an unreadable one, counts as held. A change that starts no pass releases the lock at once. A pass releases it when it ends, in the same tick in which it stops counting as running, so a tool call never wakes a pass that has already ended. Tool calls run one at a time, so a re-read never replaces a workflow that another call is changing.

**Pass.** A pass is one run of the SDK workflow `dw-drive`. The tool handler starts it without waiting, with `notifyOnComplete` set so the main agent is notified when the pass ends. A pass:

1. Puts steps that an interrupted run left in progress back in the queue. It skips steps waiting for the user. Their `lastError` says the previous attempt was interrupted and may have done part of the work.
2. Keeps up to `concurrency` steps running. Each step is one `ctx.agent` call labelled `<id>#<attempt>`. Each attempt gets a new label, so the SDK never reuses an earlier result. A finished step frees its slot at once; there's no batch barrier.
3. Looks for new ready steps when a tool adds or answers a step mid-pass, because the tool wakes it.
4. Ends when nothing is running and nothing is ready. The result is `done`, `waiting` (with the open questions) or `stuck`.

A hard error such as cancellation stops new dispatches. The running steps settle, the pass ends, and `dw_run` recovers later. If work became runnable just as a pass ended, the host starts another pass.

**Step prompt.** Built fresh for each attempt, it contains:

- the goal;
- the step and its attempt number, or the goal-check instructions;
- the directory and the check;
- the steps it waited for, with their labels and results;
- the previous attempt's error;
- the question and answer;
- the other steps, marking the ones running now;
- the rules: do only this step, don't call `dw_*` tools or edit the workflow file, and never weaken checks or tests;
- the report format.

## 6. Questions

A step asks the user when it reports `needs_user`, reports `failed`, or fails the same way twice. The question is stored on the step, which stays in progress and is marked as waiting. Other steps keep running, and the pass ends `waiting` once only waiting steps are left.

- The session shows a warning when a step asks.
- On every user message, the `onUserPromptSubmitted` hook adds the open questions to the main agent's context. Questions of a workflow that another live process drives are left out; they are answered in that process.
- The main agent passes the user's answer to `dw_answer`, never its own guess. This is a prompt rule only: in the dogfood run (§11), the main agent answered for the user. The step then runs again with the question and answer in its prompt.

## 7. Parallelism

The main agent chooses `concurrency` when it plans, based on how independent the steps are. Steps that run together must not edit the same files or switch branches in the same checkout.

For one branch per item, the skill says to either create a git worktree per item and set each step's `cwd` to it, or use concurrency 1. Each step's prompt lists the steps running at the same time and tells the agent not to change their files. `dw_run` can change the concurrency later.

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

| Tool | Purpose |
| --- | --- |
| `dw_plan(goal, concurrency, tasks, goalCheck?, goalCwd?)` | Create a workflow and start it in the background. Bad plans (duplicate ids, unknown dependencies, cycles) are rejected before anything is saved. |
| `dw_status(workflowId?, wait?)` | Show steps, results, errors and questions; with no id, list all workflows. `wait: true` blocks until the run stops. |
| `dw_answer(workflowId, nodeId, answer)` | Give a waiting step the user's answer; the step runs again. |
| `dw_add_task(workflowId, task, blocks?)` | Add a step. `blocks` lists steps that haven't started and must wait for it. |
| `dw_run(workflowId, concurrency?)` | Resume a paused workflow, optionally with a new concurrency. |

- All tools are always loaded (`defer: "never"`).
- `dw_status` and `dw_answer` skip the permission prompt.
- Errors go back to the model as failed tool results that say what to fix.
- There is no tool to remove a step, remove a dependency or complete a step, because each of those could silently drop work.

## 10. What code enforces, and what it trusts

The concern: could the AI change the graph to cut corners and skip work?

Code enforces:

- A step completes only through its own `done` report and a passing check.
- The workflow is done only when every node is complete, including the goal step.
- A report can only add work: new steps, and new waits for its own step or for the steps that waited for it. It can't remove, complete or edit other steps.
- Nothing removes a step once it's in the graph.

Code trusts the model for the following. The goal step re-checks the result.

- The plan. The main agent writes the steps and their checks, and a weak check is a weak gate.
- Not weakening tests or checks. The step prompt forbids it.
- Not editing `.copilot/workflows/` or calling `dw_*` tools from a step. The prompt forbids it, but nothing technically prevents it. An edit made during a run is overwritten by the next write.
- Passing only the user's words to `dw_answer`. The main agent broke this in the dogfood run (§11).

## 11. Tried it

**Unit tests.** 30 tests use `node --test` with a fake agent and fake checks. They cover:

- the concurrency pool and dependency order;
- a failing check retried with its output, and the same failure twice turning into a question;
- `needs_user` with answers, `blocked`, discovered work, and the goal step adding work;
- the goal step asking for the same work twice, and steps added while it runs;
- a report that would create a cycle being rejected without changes;
- crash recovery from the saved file;
- bad plans, added-step ids, steps added mid-pass, and the check runner with `CI=true`;
- the run lock, a second process that must not act on an old copy, answers given at the same time, unreadable workflow files, and the paused-workflow hint.

**Real runs.** The first four used Copilot CLI 1.0.93 with `--plugin-dir`, non-interactive (`-p`).

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
- Review afterwards found that the lock fix still let a second process act on its old copy of a workflow. That process re-ran finished steps and overwrote the other process's results, and a pass's lock release could swallow a wake-up. Both were fixed by hand, as described in §5.

What the runs taught:

- Agents run their check before reporting, as the prompt asks, so the driver rarely needs to retry. The retry path needed a rigged check to show up.
- `failed` asks the user at once. In the questions trial, that turned a spurious refusal into a question. We kept it: an agent that says it can't continue shouldn't be retried blindly, and the user can answer "try again".
- In the migration trial, the main agent set up the worktrees itself; in the dogfood run, it planned a setup step.
- An interrupted attempt originally gave the next attempt no hint. Recovery now records that the step was interrupted.
- "Only the user answers questions" is a prompt rule. When the questions came from its own mistake, the main agent answered them itself. The skill and the `dw_answer` description now say so explicitly, but nothing enforces it.
- A wrong check can't be fixed from inside a run. It fails the same way every time, so the step can only ask again. The prompt, the tool description and the skill now say that checks start in the step's `cwd`.
- Step subagents ask for permissions as the main agent does. An interactive run needs the tools allowed up front, or the user gets one prompt per shell command.

## 12. Limitations and deferred work

Limitations:

- The run lock only covers one machine: a lock from another host is never taken over automatically, and a lock file left behind must then be deleted by hand (the refusal names the file). Two processes taking over the same dead lock at the same moment could both win.
- A check is fixed once planned. A wrong check fails the same way on every attempt, and the step can only ask the user again; the answer can't replace the check.
- `dw_answer` takes whatever the main agent passes. Only the prompt keeps the main agent from answering for the user.
- Step subagents' permission requests reach the session like the main agent's own, one per shell command.
- Agents-app sessions (ACP) can't use the plugin: they don't load extensions, and the app pins CLI 1.0.88, whose SDK has no `session.workflow`. It works in the CLI, interactive or `-p`, and in SDK sessions that request extensions.
- Checks have no timeout.
- A goal step that keeps finding different work has no round limit; only a repeated request asks the user.
- Workflows don't resume on their own in a new session; the first prompt only mentions them.
- Steps run at least once: an interrupted step runs again, so instructions should be safe to repeat.

Changes from the v2 design:

| v2 | v1 | Why |
| --- | --- | --- |
| Node kinds `task`, `ask` and `goal-check` | One node type. Questions live on the step, and the goal is a node with a reserved id. | Fewer moving parts. The step runs again with the answer in its own context. |
| `stage`, `acceptance` and `parent` fields | `instructions` and `check`. The stage guidance lives in the skill. | A check is a stronger definition of done than an acceptance sentence. |
| Edges without labels | Labelled edges (p-graph edge data) | The label tells a step why it waited, for example `found by review`. |
| Concurrency 1 by default, no worktrees | The AI chooses concurrency; worktrees through `cwd` | The owner's call: let the AI parallelize, with checks as the guard. |
| Whole-snapshot writes and a `.bak` file | p-graph `GraphStore` change batches and atomic writes | p-graph gained a store interface. |
| Lockfile, owner session and auto-start on session start | A per-workflow pid lock file, held while a process runs or changes the workflow; no owner session; an explicit `dw_run` (the first prompt mentions paused workflows) | Prevents two processes from driving one workflow or acting on an old copy; keeps v1 simple. |
| Retry once on failure, then ask | Retry while failures differ; `failed` asks at once | No arbitrary counts. |
| Driver-generated ids (`parent.n`) | Planner ids, slugged, with a suffix on collision | Readable ids in status and prompts. |
| `dw_add_dependency` and `dw_start` | `blocks` on `dw_add_task`; `dw_plan` starts and `dw_run` resumes | Fewer tools. |

Also parked:

- splitting p-graph into graph data and a replaceable runner;
- a priority tool;
- a session executor;
- a hard round limit for the goal step (only repeated requests ask the user today);
- a way for the user to replace a wrong check, for example a `check` on `dw_answer`. The main agent can call `dw_answer` itself, so this would also let it weaken checks; it needs a decision first.

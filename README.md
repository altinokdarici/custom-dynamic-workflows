# custom-dynamic-workflows

A GitHub Copilot CLI plugin (an MCP server, a prompt hook and a skill) that turns a task you describe in plain language into a graph of steps and runs every step to completion. Steps run in parallel where that's safe. Commands, not the model, decide when a step is done. The workflow asks you only when it's stuck.

```text
you: Migrate every skill and agent in .claude/ to the Copilot layout, one branch per item.
     `npm run evals -- <name>` must pass for each.

copilot ─ dw_plan ─▶  migrate-commit-helper ─┐
                      migrate-code-review ───┤
                      migrate-release-notes ─┼─▶ goal
                      migrate-test-writer ───┘
```

The graph is a [p-graph](https://github.com/altinokdarici/p-graph): a dynamic priority graph with labelled edges. Steps can add steps while it runs.

## How it works

1. **Plan.** The main agent reads the repo (guided by the `dynamic-workflow` skill) and calls `dw_plan` with:
   - the goal;
   - stage-sized steps, each with instructions and an optional `check` command;
   - their dependencies;
   - a `concurrency`, which the agent chooses based on how independent the steps are.
2. **Run.** Every `dw_*` reply hands out the ready steps, in priority order, up to `concurrency` at a time, each with its full prompt and an attempt number. The main agent launches each one as a background `task` subagent. When a subagent finishes, the main agent passes its final message to `dw_report`, and the reply hands out the steps that became ready. Every step ends with a JSON report: `done`, `blocked`, `needs_user` or `failed`.
3. **Check.** When a step reports `done`, `dw_report` runs the step's `check` from the repo root, in code. A step completes only when its check exits 0. A report for an attempt that is no longer running is rejected.
4. **Recover.**

   | What happened | What the workflow does |
   | --- | --- |
   | Check fails | Retries the step with the check's output. |
   | Same failure twice | Asks you. |
   | `blocked` | Runs the new prerequisite steps the report lists, then the step again. |
   | Extra work found by a `done` step | Steps that waited for that step also wait for the new work. |
   | `needs_user` or `failed` | Asks you. |
   | Subagent or session gone mid-step | `dw_run` puts the step back in the queue with a new attempt number and tells it to check what the interrupted one already did. |

5. **Goal check.** A final `goal` step depends on every other step. It checks the goal against the repo (and runs `goalCheck` if you gave one), and adds steps for anything that's missing. If steps are added while it runs, it runs again after them. If it asks for the same work twice in a row, it asks you instead of adding it again.

Workflows with work left are mentioned to the main agent on your first message of a session (by the prompt hook); it offers `dw_run` and never resumes them on its own. Checks run with `CI=true`, so test runners don't start watch mode.

Questions come back in the `dw_report` reply, and the hook repeats open ones on every message. The main agent asks you; the skill and every reply tell it never to answer for you. Answer in chat; the agent passes your answer on with `dw_answer`, and can replace a wrong step check with it. The reply flags a check change with ⚠, and every answer and check change is listed when the workflow finishes. The goal check can't be changed.

## Tools

| Tool | Purpose |
| --- | --- |
| `dw_plan` | Create a workflow; hands out the first steps. |
| `dw_report` | Pass a finished subagent's final message; runs the check and hands out the next steps. |
| `dw_next` | Show what to do next: steps to launch, reports still expected, questions. |
| `dw_answer` | Give a waiting step the user's answer, optionally with a corrected `check`; the step is handed out again. |
| `dw_add_task` | Add a step. `blocks` makes steps that haven't started wait for it. |
| `dw_run` | Requeue steps whose subagent is gone (a new session, a restart) and hand them out again. Can change concurrency. |
| `dw_status` | Show steps, results, errors and questions, or list the repo's workflows. |
| `dw_view` | Return the step graph, colored by status, as an HTML page. In Agents sessions the skill shows it with `canvas_show` and refreshes it after every step. |

Every tool takes `cwd`, the main agent's working directory, because one MCP server serves every session of the CLI process; workflows belong to its git repository.

## State

Each workflow is one JSON file: `.copilot/workflows/<id>.json` in the project, which ignores itself through its own `.gitignore`. It holds the goal, the concurrency and the p-graph snapshot. Each node stores:

- what the planner wrote: `title`, `instructions` and `check?`;
- what only the tools write: `attempts`, `lastError?`, `result?`, `question?`, `answer?` and `history?` (every answer and check change).

Edges carry an optional `label` that says why one step waits for another.

Every tool call reads the workflow from disk and writes it back before it returns, so no session acts on an old copy. Calls for one repo run one at a time; a check runs between two of them, so a slow check doesn't hold up other reports.

Every graph change goes through p-graph's store interface and is written atomically. If a session ends mid-run, `dw_run` picks the workflow up again: interrupted steps go back in the queue, marked as interrupted, with a new attempt number.

## Use it

Requires Node 22.18 or later on `PATH`. Works in the terminal CLI, in `-p` runs and in Agents-app (ACP) sessions.

```sh
copilot plugin install /path/to/custom-dynamic-workflows   # every session
copilot --plugin-dir /path/to/custom-dynamic-workflows     # one session
```

Then describe the work and ask for a dynamic workflow, or just describe work that obviously splits into stages.

Step subagents ask for permissions just as the main agent does. Allow the tools the steps need before a long run.

## Develop

```sh
npm install
npm test           # node:test with a fake agent and fake checks
npm run typecheck
npm run build      # bundles src/ into dist/mcp.mjs (MCP server) and dist/hook.mjs (prompt hook)
```

The bundles are committed, because the plugin runs them directly (`.mcp.json`, `hooks/hooks.json`). Rebuild after changing `src/`.

| File | Role |
| --- | --- |
| `src/workflow.ts` | The graph rules: adding steps, applying reports, retry-or-ask, answers, recovery. |
| `src/prompt.ts` | The step prompt and the report schema. |
| `src/host.ts` | Tool handlers: load, hand out steps, run checks, apply reports, save. |
| `src/mcp.ts` | The stdio MCP server: tool schemas and descriptions. |
| `src/hook.ts` | The `UserPromptSubmit` hook: open questions, and workflows with work left. |
| `src/store.ts`, `src/check.ts` | JSON-file store and the check runner. |

## Tried it

Version 0.1 was a Copilot CLI extension that ran steps in a background SDK workflow. Agents-app (ACP) sessions never load extensions, so 0.2 moved to an MCP server, a hook and a skill, with the main agent launching the subagents. The rules and checks are unchanged. The runs below used 0.1.

With Copilot CLI 1.0.93, non-interactive (`-p`):

- **Migration.** A sandbox repo had three skills and one agent in `.claude/`, one of them broken on purpose. The task was to move each one to the Copilot layout on its own branch, with `npm run evals -- <name>` as its check. The main agent created four worktrees and ran four steps at concurrency 4. The run took 2 minutes and every check passed on the first attempt, including the broken item, which its agent fixed.
- **Retry and crash.** A check rigged to fail once sent its step back with the output, and attempt 2 passed without redoing the work. Killing the CLI mid-step and calling `dw_run` from a new session finished the workflow.
- **Questions.** A step that reported `failed` became a question, and the main agent got a notification.

In an SDK session that stayed alive between turns:

- **Dogfood.** The plugin fixed five of its own limitations, one branch and worktree each, merged into local main. It took 3.6 minutes, 18 subagent runs and about 124 AI credits. The planner wrote checks that `cd` into a directory the step was already in, so every check failed until the main agent worked around it with a symlink. The completion notification woke the idle session, and the main agent then answered the five resulting questions itself instead of asking the user. Review afterwards found that a second session could act on an old copy of a workflow. The fixes that followed: one way to say where a check runs (the repo root), `dw_answer` can replace a wrong check in the open, and a session re-reads workflows it isn't running; the run lock the dogfood run added was removed again.

Details are in [DESIGN.md §11](DESIGN.md#11-tried-it).

## Limitations

- The main agent drives the run, so it spends a short turn on every finished step, and the run stops when its session ends (resume with `dw_run`).
- Two live sessions can drive the same workflow; they share the concurrency, but a `dw_run` in one requeues the other's steps.
- The main agent can answer a step's question, or replace its check, without asking you. You see every answer and check change, but nothing prevents it. The goal check is the backstop: it can't be changed.
- Checks have no timeout.
- A goal check that keeps finding different work has no round limit; only a repeated request asks you.
- Workflows don't resume on their own in a new session; you're told about them and call `dw_run`.
- An interrupted step runs again, so step instructions should be safe to repeat.

See [DESIGN.md](DESIGN.md) for the reasoning.

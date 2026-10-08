# custom-dynamic-workflows

A GitHub Copilot CLI plugin that turns a task you describe in plain language into a graph of steps and runs every step to completion. Steps run in parallel where that's safe. Commands, not the model, decide when a step is done. The workflow asks you only when it's stuck.

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
   - stage-sized steps, each with instructions, an optional `check` command and an optional `cwd` (for example a git worktree);
   - their dependencies;
   - a `concurrency`, which the agent chooses based on how independent the steps are.
2. **Run.** A background run takes ready steps in priority order and runs up to `concurrency` of them at once, each as its own subagent. Every step ends with a structured report: `done`, `blocked`, `needs_user` or `failed`.
3. **Check.** When a step reports `done`, the driver runs the step's `check` in the step's directory. A step completes only when its check exits 0.
4. **Recover.**

   | What happened | What the workflow does |
   | --- | --- |
   | Check fails | Retries the step with the check's output. |
   | Same failure twice | Asks you. |
   | `blocked` | Runs the new prerequisite steps the report lists, then the step again. |
   | Extra work found by a `done` step | Steps that waited for that step also wait for the new work. |
   | `needs_user` or `failed` | Asks you. |
   | Session ended mid-step | `dw_run` puts the step back in the queue and tells its next attempt to check what the interrupted one already did. |

5. **Goal check.** A final `goal` step depends on every other step. It checks the goal against the repo (and runs `goalCheck` if you gave one), and adds steps for anything that's missing. If steps are added while it runs, it runs again after them. If it asks for the same work twice in a row, it asks you instead of adding it again.

Paused workflows with work left are mentioned to the main agent on your first message of a session; it offers `dw_run` and never resumes them on its own. Checks run with `CI=true`, so test runners don't start watch mode.

Questions show up as session warnings, and in the main agent's context on your next message. Answer in chat; the agent passes your answer on with `dw_answer`.

## Tools

| Tool | Purpose |
| --- | --- |
| `dw_plan` | Create a workflow and start it in the background. |
| `dw_status` | Show steps, results, errors and questions. `wait: true` blocks until the run stops. |
| `dw_answer` | Give a waiting step the user's answer; the step runs again. |
| `dw_add_task` | Add a step. `blocks` makes steps that haven't started wait for it. |
| `dw_run` | Resume a paused workflow, for example after a restart. Can change concurrency. A workflow another live Copilot process is driving is refused. |

## State

Each workflow is one JSON file: `.copilot/workflows/<id>.json` in the project, which ignores itself through its own `.gitignore`. It holds the goal, the concurrency and the p-graph snapshot. Each node stores:

- what the planner wrote: `title`, `instructions`, `check?` and `cwd?`;
- what only the driver writes: `attempts`, `lastError?`, `result?`, `question?` and `answer?`.

Edges carry an optional `label` that says why one step waits for another.

While a Copilot process runs or changes a workflow, it holds `<id>.lock` next to the JSON file. Another process can't run or change that workflow until then; it reads the file again before showing it, and again after taking the lock, so it never acts on an old copy. A lock from a dead process is taken over.

Every graph change goes through p-graph's store interface and is written atomically. If a session ends mid-run, `dw_run` picks the workflow up again: interrupted steps go back in the queue, marked as interrupted.

## Use it

Requires a Copilot CLI with dynamic workflows (`--experimental`).

```sh
copilot --experimental --plugin-dir /path/to/custom-dynamic-workflows
```

Then describe the work and ask for a dynamic workflow, or just describe work that obviously splits into stages.

Step subagents ask for permissions just as the main agent does, one prompt per shell command. Allow the tools the steps need before a long run. Agents-app sessions can't run the plugin, because they don't load extensions.

## Develop

```sh
npm install
npm test           # node:test with a fake agent and fake checks
npm run typecheck
npm run build      # bundles src/ + p-graph into extensions/dynamic-workflows/extension.mjs
```

The built bundle is committed, because the CLI loads `extension.mjs` directly. Rebuild it after changing `src/`.

| File | Role |
| --- | --- |
| `src/workflow.ts` | The graph rules: adding steps, applying reports, retry-or-ask, answers, recovery. |
| `src/driver.ts` | One pass: the concurrency pool and running each step. |
| `src/prompt.ts` | The step prompt and the report schema. |
| `src/host.ts` | Workflow registry and tool handlers: re-reads workflows other processes may have changed, takes the run lock before changing one, and restarts a pass when new work arrives. |
| `src/lock.ts` | The per-workflow run lock. |
| `src/extension.ts` | SDK glue: `joinSession`, the `dw-drive` workflow, the tools and the prompt hook. |
| `src/store.ts`, `src/check.ts` | JSON-file store and the check runner. |

## Tried it

With Copilot CLI 1.0.93, non-interactive (`-p`):

- **Migration.** A sandbox repo had three skills and one agent in `.claude/`, one of them broken on purpose. The task was to move each one to the Copilot layout on its own branch, with `npm run evals -- <name>` as its check. The main agent created four worktrees and ran four steps at concurrency 4. The run took 2 minutes and every check passed on the first attempt, including the broken item, which its agent fixed.
- **Retry and crash.** A check rigged to fail once sent its step back with the output, and attempt 2 passed without redoing the work. Killing the CLI mid-step and calling `dw_run` from a new session finished the workflow.
- **Questions.** A step that reported `failed` became a question, and the main agent got a notification.

In an SDK session that stayed alive between turns:

- **Dogfood.** The plugin fixed five of its own limitations, one branch and worktree each, merged into local main. It took 3.6 minutes, 18 subagent runs and about 124 AI credits. The planner wrote checks that `cd` into a directory the step was already in, so every check failed until the main agent worked around it with a symlink. The completion notification woke the idle session, and the main agent then answered the five resulting questions itself instead of asking the user. Review afterwards found and fixed a gap in the new lock: a second process could still act on an old copy of a workflow.

Details are in [DESIGN.md §11](DESIGN.md#11-tried-it).

## Limitations

- The run lock covers one machine; a lock left by another host has to be deleted by hand (the refusal names the file).
- A check can't be changed after planning. A wrong check fails the same way every time, and the step keeps asking you.
- Only the prompt keeps the main agent from answering a step's question itself.
- Agents-app (ACP) sessions don't load extensions, so they can't run the plugin.
- Checks have no timeout.
- A goal check that keeps finding different work has no round limit; only a repeated request asks you.
- Workflows don't resume on their own in a new session; you're told about them and call `dw_run`.
- An interrupted step runs again, so step instructions should be safe to repeat.

See [DESIGN.md](DESIGN.md) for the reasoning.

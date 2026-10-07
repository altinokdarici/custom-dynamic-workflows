---
name: dynamic-workflow
description: Run a multi-step task as a dynamic workflow - a dependency graph of steps that runs in the background, in parallel where safe, with code-run checks, until every step and a final goal check are done. Use when the user asks for work that splits into several stage-sized steps (migrating many items, a change across several packages, one branch or PR per item), or says "run this as a workflow".
---

# Dynamic workflows

The `dw_*` tools run a task as a graph of steps. Each step runs as its own agent. Steps can add follow-up steps while they run. When a step reports done, the driver runs that step's `check` command. If the check fails, the step is retried with the check's output. If a step fails the same way twice, the workflow asks the user. A final `goal` step verifies the whole goal and adds steps for anything that's missing.

## Planning: `dw_plan`

1. Look at the repository first so the plan matches reality: the files, package scripts, and how the work is verified.
2. Split the work into stage-sized steps: one item, one package or one concern each. Don't use one step per command, and don't put everything in a single step. If the user names the stages, use them as given.
3. For each step:
   - `instructions`: self-contained. The step's agent sees only these instructions, the goal, and the results of the steps it depends on. Say what to change, where, and what done looks like.
   - `check`: a shell command that proves the step is done, such as `npm test -- foo` or `node scripts/evals.mjs foo`. Add one whenever a command can verify the step.
   - `dependsOn`: only real ordering needs. Use `{ "id": "...", "label": "why" }` when the reason helps the later step.
   - `cwd`: set it when the step works in a different directory, such as a git worktree that an earlier step creates.
4. `concurrency`: decide how many steps can safely run at once. Steps that run together must not edit the same files or switch branches in the same checkout. For one branch per item, either create a git worktree per item (keep `.worktrees/` git-ignored) and set `cwd` to it, or use concurrency 1.
5. `goal`: state it as the user would verify it. Add a `goalCheck` command if one exists.

## While it runs

- `dw_plan` returns immediately and the workflow runs in the background. Tell the user it started, then end your turn. Don't do the steps yourself. You'll get a notification when the run finishes or needs the user.
- `dw_status` shows the steps, results, errors and questions. `wait: true` blocks until the workflow stops running. Use it only when you must stay in this turn, for example in a non-interactive run.
- When a step asks a question, put it to the user and pass their answer to `dw_answer`. Never answer for them.
- `dw_add_task` adds a step the user asks for. `dw_run` resumes a paused workflow, for example after a restart.

Workflow state lives in `.copilot/workflows/<id>.json`, which is git-ignored. Don't edit it by hand.

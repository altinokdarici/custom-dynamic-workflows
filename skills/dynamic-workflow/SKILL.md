---
name: dynamic-workflow
description: Run a multi-step task as a dynamic workflow - a dependency graph of steps, each run by its own subagent, in parallel where safe, with code-run checks, until every step and a final goal check are done. Use when the user asks for work that splits into several stage-sized steps (migrating many items, a change across several packages, one branch or PR per item), or says "run this as a workflow".
---

# Dynamic workflows

The `dw_*` tools (from the dynamic-workflows MCP server) keep a task as a graph of steps. You run the steps: the tools tell you which steps to launch, you run each one as a subagent, and you hand each subagent's report back. The tools own the rules. When a step reports done, they run its `check` command in code. If the check fails, the step goes back with the check's output. If a step fails the same way twice, it asks the user. A final `goal` step verifies the whole goal and adds steps for anything that's missing. Steps can add follow-up steps.

Every tool takes `cwd`: the absolute path of your current working directory.

## Planning: `dw_plan`

1. Look at the repository first so the plan matches reality: the files, package scripts, and how the work is verified.
2. Split the work into stage-sized steps: one item, one package or one concern each. Don't use one step per command, and don't put everything in a single step. If the user names the stages, use them as given.
3. For each step:
   - `instructions`: self-contained. The step's agent sees only these instructions, the goal, and the results of the steps it depends on. Say what to change, where, and what done looks like.
   - `check`: a shell command that proves the step is done, such as `npm test -- foo` or `node scripts/evals.mjs foo`. Add one whenever a command can verify the step. It runs from the repo root; for a step in a worktree, write `cd .worktrees/foo && npm test`.
   - `dependsOn`: only real ordering needs. Use `{ "id": "...", "label": "why" }` when the reason helps the later step.
   - When a step's result decides the follow-up work (an audit that splits work into groups), tell that step to return the follow-ups as `newTasks` in its report. They are then added before the goal check starts.
4. `concurrency`: decide how many steps can safely run at once. Steps that run together must not edit the same files or switch branches in the same checkout. For one branch per item, either create a git worktree per item (keep `.worktrees/` git-ignored) and say in the step's instructions to work there, or use concurrency 1.
5. `goal`: state it as the user would verify it. Add a `goalCheck` command if one exists. It can't be changed later: it is the definition of done.

## Running the steps

Every `dw_*` reply ends with what to do next. Follow it until the workflow is done:

1. **Launch.** For each `### workflowId …, stepId …, attempt …` block, start a background `task` subagent (agent_type `general-purpose`, mode `background`) whose prompt is the text inside `<step-prompt>`, exactly as written. Launch all of them at once. Tell the user briefly which steps started.
2. **Report.** When a subagent finishes, read its final message (`read_agent`) and call `dw_report` with `workflowId`, `stepId`, `attempt` and that message unchanged as `report`. If the subagent failed or was cancelled, report the error text instead. Then launch whatever the reply hands out.
3. **Progress view.** In Agents, the step graph appears in the user's side panel and updates by itself; `dw_plan` says so. Only if it doesn't say so and you have a `canvas_show` tool, call `dw_view` after `dw_plan` and after every `dw_report`, `dw_answer`, `dw_add_task` and `dw_run`, and pass the page it returns to `canvas_show` unchanged.
4. **Wait.** While subagents are still running and nothing new is handed out, end your turn; you are notified when one finishes.
5. **Done.** When a reply says the workflow is done, tell the user, including any answers and check changes it lists.

Rules:
- Never do a step's work yourself, never edit a step's report, and never edit `.copilot/workflows/`. The checks only mean something if the step's own subagent did the work.
- When a step asks a question, put it to the user (with `ask_user` if you have it) and pass their answer to `dw_answer`. Never answer for them. If you can see the cause, such as a wrong check, tell the user what you found and propose the fix. To replace a step's check, pass the new one as `check` and tell the user.
- `dw_add_task` adds a step the user asks for. Steps added while the goal check runs make it run again after them. Reports that name an unfinished step's id refer to that step, so they never duplicate it. `dw_status` shows the steps, results, errors and questions.
- A workflow is driven by the session whose subagents run its steps. If those subagents are gone (a new session, a restart), `dw_run` sends their steps out again with a new attempt number; reports from old attempts are rejected. Never call `dw_run` while your own subagents are still running steps of that workflow.

Workflow state lives in `.copilot/workflows/<id>.json`, which is git-ignored.

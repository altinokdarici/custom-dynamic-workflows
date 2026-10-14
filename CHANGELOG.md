# Changelog

## 0.7.0

- Guards checks: a step's git changes since it started are compared against a baseline. Added skip markers, deleted tests, and edits to files or npm scripts that a check runs send the step to the user instead of completing it.
- The finished workflow lists what it rests on beyond checks written at planning: steps added mid-run, steps without a check, and a goal without a goal check command. Status marks steps added mid-run.
- README: the "no false success" guarantee is now "checks written up front, enforced later", and says it is best effort.

## 0.6.0

- Renamed from custom-dynamic-workflows to **work-graph** (repo, plugin, MCP server and skill). The marketplace is now `work-graph`: `claude plugin install work-graph@work-graph`.
- Shorter tool names; hosts already prefix them with the server name (`work-graph-plan`, `mcp__plugin_work-graph_work-graph__plan`): `plan`, `next`, `report`, `answer`, `add_step` (was `dw_add_task`), `resume` (was `dw_run`), `status`, `view`.
- The MCP server reports the package version.
- Existing workflows in `.copilot/workflows/` still resume.

## 0.5.0

- Works in Claude Code as well as Copilot CLI: host-neutral subagent launch instructions, and `plugin.json` paths that pass `claude plugin validate`.
- The prompt hook prints its context in both forms (`additionalContext` and `hookSpecificOutput.additionalContext`), so Claude Code no longer drops it.
- Uses [`@altinok/p-graph`](https://www.npmjs.com/package/@altinok/p-graph) from npm instead of a GitHub dependency.
- Requires Node 24.
- MIT license, security policy, contributing guide and CI.

Earlier versions are in the git history.

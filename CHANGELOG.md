# Changelog

## 0.5.0

- Works in Claude Code as well as Copilot CLI: host-neutral subagent launch instructions, and `plugin.json` paths that pass `claude plugin validate`.
- The prompt hook prints its context in both forms (`additionalContext` and `hookSpecificOutput.additionalContext`), so Claude Code no longer drops it.
- Uses [`@altinok/p-graph`](https://www.npmjs.com/package/@altinok/p-graph) from npm instead of a GitHub dependency.
- Requires Node 24.
- MIT license, security policy, contributing guide and CI.

Earlier versions are in the git history.

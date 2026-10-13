# Security

## What this plugin runs

The plugin executes shell commands on your machine, with your permissions:

- **Step checks** (`check`) and the **goal check** (`goalCheck`) are shell commands the planning agent writes. The MCP server runs them from the repository root, with `CI=true`, when a step reports `done`. They are not sandboxed and have no timeout.
- **Step subagents** run with whatever tools and permissions your agent host grants them. The plugin doesn't widen or narrow those permissions.

Treat a workflow like a script the agent wrote for you: read the plan (`dw_status`) before a long unattended run, and allow only the tools the steps need. Run untrusted repositories in a container or VM.

Workflow state is stored in `.copilot/workflows/` inside the repository, which ignores itself through its own `.gitignore`. It holds the goal, step instructions, check commands, step summaries and your answers. Don't put secrets in any of them.

## Reporting a vulnerability

Please don't put details in a public issue. Use GitHub's private vulnerability reporting (**Security → Report a vulnerability**) on this repository. If that isn't available, open an issue asking for a private contact, without details.

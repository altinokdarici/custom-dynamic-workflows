# Contributing

Issues and pull requests are welcome. For anything bigger than a fix, open an issue first. The design is deliberately small, and [DESIGN.md §12](DESIGN.md#12-limitations-and-deferred-work) lists what was cut on purpose.

## Setup

Requires Node 24 or later.

```sh
npm install
npm test           # node:test with a fake agent and fake checks
npm run typecheck
npm run build      # rebuild dist/ after changing src/
```

`dist/` is committed because hosts run the bundles directly. CI fails if `dist/` doesn't match `src/`, so commit the rebuilt bundles with your change.

## Ground rules

- **Code owns control flow.** Rules about when a step is done, what runs next and when to ask the user belong in `src/workflow.ts` and `src/host.ts`, with tests. Not in prompts.
- **Reports only add work.** Don't add a way for an agent to remove, skip or complete a step.
- Every behavior change needs a test in `test/`. The helper in `test/helpers.ts` plays the main agent with scripted reports and fake checks.
- Update README.md and DESIGN.md when behavior changes.

## Trying a change in a real host

```sh
copilot --plugin-dir .          # GitHub Copilot CLI
claude --plugin-dir .           # Claude Code
claude plugin validate .        # manifest check
```

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**code-stroll** — an opencode plugin that turns code review into an interactive learning session. It presents diff changes grouped semantically, one chunk at a time, with Q&A and proactive explanations. Designed for reviewing agent-generated code where understanding *why* matters more than just finding bugs.

## Commands

```bash
bun install          # install dependencies
bun run build        # build plugin to dist/
bun test             # run all tests
bun test src/git.test.ts   # run a single test file
bun --watch src/index.ts   # dev mode with file watching
./install.sh /path/to/project  # install plugin into a target project
```

Tests use `bun:test`. Test files are co-located with source (`src/*.test.ts`) except for integration tests in `src/integration/`. The integration test creates a temporary fixture git repo and has a 30s timeout.

## Architecture

The plugin is built on `@opencode-ai/plugin` and exposes two tools to opencode:

- **`code_stroll_start`** — Creates an isolated git worktree for the branch under review, runs `git diff`, parses hunks, groups them by file, persists session state, and returns all diff hunks for the agent to present.
- **`code_stroll_cleanup`** — Removes the worktree and session file.

### Source modules (`src/`)

| Module | Responsibility |
|---|---|
| `index.ts` | Plugin entry point. Registers tools via `@opencode-ai/plugin`. Orchestrates the flow: worktree → diff → parse → group → session. |
| `git.ts` | `parseHunks()` parses raw unified diff into `Hunk[]`. `createReviewWorktree()`, `getDiff()`, `removeWorktree()` manage git operations via `Bun.spawn`. |
| `grouper.ts` | `groupByFile()` groups hunks into `Group[]` by filename (fallback grouping; semantic LLM grouping is delegated to the review agent). |
| `session.ts` | Read/write `SessionState` to `.opencode/review-session.json`. Version-checked on load. |
| `types.ts` | Core types: `Hunk`, `Group`, `SessionState`, `ReviewParams`, `Depth`, `GroupStatus`. |

### Config files (`config/`)

- `commands/code-stroll.md` — opencode slash command definition. Routes to the review agent.
- `agents/review-agent.md` — System prompt for the conversational review agent. Defines the chunk-by-chunk presentation flow, depth modes, Q&A protocol, and findings file format.

### Key design decisions

- The plugin returns **all hunks at once** to the agent, which does semantic grouping in-context rather than via a separate LLM call. `groupByFile()` in `grouper.ts` is the fallback.
- Git worktrees isolate the review branch — the user's working directory is never disturbed.
- Session state is persisted to JSON so reviews can be resumed with `--resume`.
- The review agent writes findings incrementally to `reviews/{date}-{branch}.md` during the session.

# code-stroll

Interactive code review learning mode.

## What it does

Turns code review into a learning session. Presents diff changes grouped
semantically, one chunk at a time, with Q&A and proactive explanations.

## Installation

1. Copy `config/commands/code-stroll.md` → `.opencode/commands/`
2. Copy `config/agents/review-agent.md` → `.opencode/agents/`

## Usage

```
/code-stroll                          # review current branch vs main
/code-stroll --depth skim             # flag concerns only
/code-stroll --focus auth,api         # only review these directories
/code-stroll --base develop           # diff against develop instead of main
/code-stroll --resume                 # continue previous session
```

## Design

See `docs/plans/2026-03-01-code-stroll-design.md` for full architecture.

---
name: code-stroll
description: Interactive code review learning session
agent: review-agent
---

Review the code changes with these parameters:
- depth: $depth (default: deep)
- base branch: $base (default: main)
- branch to review: $branch (default: HEAD)
- focus directories: $focus (default: all)
- resume previous session: $resume (default: false)

Call the `code_stroll_start` tool with these parameters to begin.

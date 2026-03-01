---
name: code-stroll
description: Interactive code review learning session
agent: review-agent
---

<system>
Start a code-stroll session with these parameters:
- depth: $depth (default: deep)
- focus: $focus (default: all)
- resume: $resume (default: false)
- base: $base (default: main)
- branch: $branch (default: HEAD)

BEGIN_CODE_STROLL depth=$depth focus=$focus resume=$resume base=$base branch=$branch
</system>

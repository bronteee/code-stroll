---
name: learn-review
description: Interactive code review learning session
agent: review-agent
---

<system>
Start a learn-review session with these parameters:
- depth: $depth (default: deep)
- focus: $focus (default: all)
- resume: $resume (default: false)
- base: $base (default: main)

BEGIN_LEARN_REVIEW depth=$depth focus=$focus resume=$resume base=$base
</system>

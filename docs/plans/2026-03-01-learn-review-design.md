# /learn-review: Interactive Code Review Learning Mode
**Date:** 2026-03-01
**Status:** Approved
**Target:** Fork of anomalyco/opencode

---

## Problem

When reviewing agent-generated code, engineers need to understand *what was built and why* — not just whether automated checks pass. There is no structured workflow for interactively asking questions about a diff during review. The existing `/code-review` plugin finds bugs but does not support the human's learning process.

The core insight: the most important skill in the age of agentic coding is knowing *what you need to deeply understand* vs. what you can safely delegate. `/learn-review` serves the "deeply understand" mode.

---

## Scope (MVP)

- Chunked diff presentation grouped semantically by LLM pre-analysis
- Per-chunk Q&A with the review agent
- Proactive hooks surfacing key decisions per chunk
- Automated concern flagging (missing error handling, security issues, etc.)
- `--depth skim|deep` flag
- `--focus dir,...` flag to narrow scope
- `--resume` flag to continue a previous session
- File-persisted session state

**Out of scope for MVP:** dedicated TUI diff panel, keyboard navigation (n/s/q), side-by-side view, CI integration.

---

## Architecture Overview

```
.opencode/commands/learn-review.md     ← entry point (slash command)
.opencode/agents/review-agent.md       ← conversational UX (system prompt)
packages/review/
  ├── index.ts                         ← plugin: SSE listener, orchestration
  ├── git.ts                           ← worktree management, diff parsing
  ├── grouper.ts                       ← LLM semantic grouping call
  └── session.ts                       ← state file read/write
.opencode/review-session.json          ← persistent session state
.opencode/worktrees/review-<branch>/   ← temporary git worktree
```

The diff chunks are displayed as fenced `diff` code blocks injected into the normal opencode chat stream. No changes to OpenTUI (the Zig/SolidJS TUI core) are required.

---

## Flow

```
User: /learn-review --depth deep --focus auth

Plugin:
  1. Parse flags from BEGIN_LEARN_REVIEW sentinel
  2. git worktree add .opencode/worktrees/review-<branch> <branch>
  3. git -C <worktree> diff main -- auth/**
  4. LLM call → semantic groups + concerns (5-10s)
  5. Write .opencode/review-session.json
  6. POST group[0] as system message into active session

Review agent:
  For each group:
    1. Present diff chunk in ```diff block
    2. Surface one proactive hook ("Want to know why X?")
    3. Flag concerns if any
    4. Open Q&A — wait for user
    5. On user "next/skip/done" → emit ADVANCE_CHUNK (standalone line)

Plugin (on ADVANCE_CHUNK):
  - Mark group status: completed
  - Write session file
  - If more groups → inject next group
  - If last group  → inject summary prompt

Review agent:
  - Produce end summary of what was reviewed + key takeaways

Plugin (on session complete):
  - Write summary to session file
  - git worktree remove --force <path>
  - Keep session file on disk for reference
```

---

## Session State File

**Path:** `.opencode/review-session.json`

```json
{
  "branch": "feat/auth-overhaul",
  "base": "main",
  "depth": "deep",
  "focus": ["auth"],
  "worktreePath": ".opencode/worktrees/review-feat-auth-overhaul",
  "createdAt": "2026-03-01T10:00:00Z",
  "groups": [
    {
      "id": 0,
      "label": "JWT config hardening",
      "files": ["auth.ts", "config.ts"],
      "hunks": ["auth.ts:45-62", "config.ts:12-15"],
      "rawDiff": "...",
      "concerns": ["no error handling on jwt.verify"],
      "status": "completed"
    },
    {
      "id": 1,
      "label": "Retry logic with exponential backoff",
      "files": ["api.ts", "utils.ts"],
      "hunks": ["api.ts:89-103", "utils.ts:34-41"],
      "rawDiff": "...",
      "concerns": [],
      "status": "in_progress"
    }
  ],
  "summary": null
}
```

**Notes:**
- `rawDiff` stored in session so `--resume` does not need to re-run git diff
- `worktreePath` stored so `--resume` reuses the existing worktree
- `summary` is null until session completes; populated by agent at end

---

## Pre-Analysis Pass (Semantic Grouping)

Runs once at session start before any chunks are shown (~5-10s). Skipped on `--resume` if session file is valid.

### Step 1 — Create worktree

```typescript
// git.ts
export async function createReviewWorktree(branch: string): Promise<string> {
  const path = `.opencode/worktrees/review-${branch.replace(/\//g, "-")}`
  await $`git worktree add ${path} ${branch}`
  return path
}

export async function getDiff(worktreePath: string, base: string, focus?: string[]): Promise<Hunk[]> {
  const args = ["diff", base, "--unified=3", "--"]
  if (focus?.length) args.push(...focus.map(f => `${f}/**`))
  const raw = await $`git -C ${worktreePath} ${args}`.text()
  return parseHunks(raw)
}
```

The branch under review is checked out in an isolated worktree — the current working directory is never disturbed.

### Step 2 — LLM grouping call

```
System: You are analyzing a git diff. Group the hunks below into
        semantically related clusters (max 4 hunks per group,
        max ~80 lines per group). For each group: give it a label,
        list any concerns (missing error handling, no tests, security
        issues). Return JSON matching the schema: { groups: Group[] }.

User:   [full list of hunks with file + line metadata]
```

`--depth` affects the grouping prompt:
- `skim`: "Flag only high-severity concerns. Skip trivial/obvious changes."
- `deep`: "Explain architectural rationale. Note patterns and alternatives considered."

### Step 3 — Fallback

If the LLM grouping call fails or times out, fall back to grouping by file. User is warned that semantic grouping is unavailable.

---

## Sentinel Tokens

Two sentinel tokens coordinate the plugin and agent without coupling them directly:

| Token | Emitted by | Intercepted by | Effect |
|---|---|---|---|
| `BEGIN_LEARN_REVIEW depth=... focus=... resume=... base=...` | Command file | Plugin | Kicks off pre-analysis pass |
| `ADVANCE_CHUNK` (standalone line) | Review agent | Plugin | Marks group complete, injects next group |

Both tokens are only acted on when they appear as a standalone line in the SSE stream, preventing false triggers from agent prose.

---

## Review Agent System Prompt

**Path:** `.opencode/agents/review-agent.md`

```markdown
---
name: review-agent
description: Interactive code review learning session
tools:
  - read
  - bash  # restricted to git commands in worktree path
---

You are guiding an engineer through an interactive code review.
Chunks are injected one at a time by the review plugin as system messages.

For each chunk, follow this structure:

1. Present the chunk — display the raw diff in a fenced ```diff block.
   Label: "Group N/Total: <label>"

2. Surface one proactive hook — identify the single most interesting
   decision and offer to explain it. One sentence, ends with a question.
   Example: "This switches to exponential backoff — want me to explain
   why fixed-interval retry is problematic at scale?"

3. Flag concerns — if concerns were found in pre-analysis, surface them:
   "I noticed: [concern]. Want to discuss the tradeoff?"
   Skip this step if no concerns.

4. Open Q&A — "What would you like to understand about this change?"
   Answer questions until the user signals readiness to move on.
   Signals: "next", "skip", "continue", "done", "move on".

5. When the user signals readiness, respond with exactly:
   ADVANCE_CHUNK
   on a line by itself. Do not add any text after it.

Depth mode: {{depth}}
- skim: flag concerns only, keep explanations under 3 sentences
- deep: explain architectural rationale, mention alternatives considered

Never advance the chunk yourself. Always wait for the user to signal.
```

---

## Plugin Lifecycle

**Path:** `packages/review/index.ts`

```typescript
export default function reviewPlugin(opencode: OpenCodePlugin) {
  opencode.on("session.message", async (event) => {
    const { content, sessionId } = event

    // Entry point
    if (content.match(/^BEGIN_LEARN_REVIEW/)) {
      const params = parseParams(content)
      await startSession(params, sessionId, opencode.client)
      return
    }

    // Chunk advance
    if (content.trim() === "ADVANCE_CHUNK") {
      await advanceChunk(sessionId, opencode.client)
      return
    }
  })
}

async function startSession(params, sessionId, client) {
  if (params.resume && sessionFileExists()) {
    const session = loadSession()
    const nextGroup = session.groups.find(g => g.status !== "completed")
    await injectChunk(nextGroup, session.groups.length, sessionId, client)
    return
  }

  const worktreePath = await createReviewWorktree(params.branch)
  const hunks = await getDiff(worktreePath, params.base, params.focus)
  const groups = await groupHunks(hunks, params.depth)
  writeSession({ ...params, worktreePath, groups })
  await injectChunk(groups[0], groups.length, sessionId, client)
}

async function advanceChunk(sessionId, client) {
  const session = loadSession()
  const current = session.groups.find(g => g.status === "in_progress")
  current.status = "completed"
  const next = session.groups.find(g => g.status === "pending")

  if (next) {
    next.status = "in_progress"
    writeSession(session)
    await injectChunk(next, session.groups.length, sessionId, client)
  } else {
    writeSession(session)
    await injectSummaryPrompt(sessionId, client)
  }
}
```

---

## Command Interface

**Path:** `.opencode/commands/learn-review.md`

```markdown
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
```

**Usage:**
```
/learn-review                          # review current branch vs main, depth=deep
/learn-review --depth skim             # flag concerns only
/learn-review --focus auth,api         # only review changes in these directories
/learn-review --base develop           # diff against develop instead of main
/learn-review --resume                 # continue previous session
```

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Branch not found | Error in chat with `git branch --list` suggestions |
| Worktree already exists | Reuse it, warn user |
| Empty diff | Exit early: "No changes found between `<branch>` and `<base>`." |
| Diff too large (>500 hunks) | Warn, ask user to apply `--focus` to narrow scope |
| LLM grouping timeout | Fall back to file-based grouping, warn user |
| `--resume` + worktree gone | Re-create worktree, re-run diff, re-map groups by hunk ID |
| Branch amended since session | Warn: "Diff has changed since session began. Groups may be stale." |
| Corrupt session file | Discard and start fresh, warn user |
| opencode crash mid-session | Worktree left on disk; reused on next `/learn-review` for same branch |

---

## Testing Strategy

| Layer | What | How |
|---|---|---|
| `git.ts` | Diff parsing, worktree create/remove | Unit tests with fixture diffs |
| `grouper.ts` | LLM call + JSON parsing, file-based fallback | Unit tests with mocked LLM |
| `session.ts` | Read/write/resume state transitions | Unit tests |
| Plugin integration | `BEGIN_LEARN_REVIEW` → pre-analysis → chunk injection | Integration test with fixture git repo |
| Agent prompt | Proactive hook quality, concern surfacing, `ADVANCE_CHUNK` emission | Manual eval |

---

## Open Questions (Post-MVP)

- **Dedicated TUI panel**: A proper diff viewer with keyboard navigation (n/s/q) would improve the experience significantly. Requires OpenTUI changes.
- **State persistence UX**: Should completed session files be archived or deleted? Currently kept indefinitely.
- **Multi-branch support**: Session file is global — only one review session at a time. Could scope by branch name if needed.
- **`ADVANCE_CHUNK` reliability**: The sentinel token approach is pragmatic but brittle. A proper plugin API with direct chunk-advance RPC would be cleaner.

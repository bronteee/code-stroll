# learn-review Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a standalone opencode plugin that turns code review into an interactive learning session — walking engineers through semantically grouped diff chunks with Q&A, proactive hooks, and concern flagging.

**Architecture:** A TypeScript/Bun plugin package (`opencode-learn-review`) that registers a listener on opencode's SSE message stream. Two sentinel tokens (`BEGIN_LEARN_REVIEW`, `ADVANCE_CHUNK`) coordinate between the command file, the review agent, and the plugin. A pre-analysis LLM pass groups diff hunks semantically before the session starts; state is persisted to `.opencode/review-session.json` to support `--resume`. The branch under review is always checked out in an isolated git worktree so the current working directory is never disturbed.

**Tech Stack:** TypeScript, Bun (runtime + test runner), opencode plugin API, `git` CLI via shell, opencode's LLM client for grouping calls.

---

## Prerequisites

Before starting, you need a local fork of anomalyco/opencode to test against. Complete this once:

1. Fork `anomalyco/opencode` on GitHub to your account
2. `git clone https://github.com/<you>/opencode.git ~/opencode-fork`
3. `cd ~/opencode-fork && bun install`
4. `bun run dev` — verify opencode starts in the terminal
5. Note the plugin API location: look at `packages/opencode/src/plugin/` for the exact interface types you'll need in Task 6

The `learn-review` plugin repo is already initialized at `/Users/apple/ai-projects/learn-review/`.

---

### Task 1: Set Up Test Infrastructure

**Files:**
- Modify: `package.json`
- Create: `src/types.ts`
- Create: `src/types.test.ts`

**Step 1: Add bun test script and verify it runs**

```bash
cd /Users/apple/ai-projects/learn-review
bun test
```

Expected: "No test files found" (not an error — just no tests yet).

**Step 2: Create shared types**

Create `src/types.ts`:

```typescript
export type Depth = "skim" | "deep"
export type GroupStatus = "pending" | "in_progress" | "completed"

export interface Hunk {
  file: string
  startLine: number
  endLine: number
  content: string
}

export interface Group {
  id: number
  label: string
  files: string[]
  hunks: string[]        // "file:startLine-endLine"
  rawDiff: string
  concerns: string[]
  status: GroupStatus
}

export interface SessionState {
  branch: string
  base: string
  depth: Depth
  focus: string[]
  worktreePath: string
  createdAt: string
  groups: Group[]
  summary: string | null
}

export interface ReviewParams {
  depth: Depth
  focus: string[]
  resume: boolean
  base: string
  branch: string
}
```

**Step 3: Write a smoke test to verify imports work**

Create `src/types.test.ts`:

```typescript
import { expect, test } from "bun:test"
import type { SessionState } from "./types"

test("SessionState type is importable", () => {
  const s: SessionState = {
    branch: "feat/test",
    base: "main",
    depth: "deep",
    focus: [],
    worktreePath: ".opencode/worktrees/review-feat-test",
    createdAt: new Date().toISOString(),
    groups: [],
    summary: null,
  }
  expect(s.branch).toBe("feat/test")
})
```

**Step 4: Run test**

```bash
bun test
```

Expected: PASS — 1 test, 0 failures.

**Step 5: Commit**

```bash
git add src/types.ts src/types.test.ts package.json
git commit -m "feat: add shared types and test infrastructure"
```

---

### Task 2: Implement session.ts (State File Read/Write)

**Files:**
- Create: `src/session.ts`
- Create: `src/session.test.ts`

**Step 1: Write failing tests**

Create `src/session.test.ts`:

```typescript
import { expect, test, beforeEach, afterEach } from "bun:test"
import { writeSession, loadSession, sessionExists, SESSION_PATH } from "./session"
import type { SessionState } from "./types"
import { rmSync, mkdirSync } from "fs"

const testSession: SessionState = {
  branch: "feat/auth",
  base: "main",
  depth: "deep",
  focus: ["auth"],
  worktreePath: ".opencode/worktrees/review-feat-auth",
  createdAt: "2026-03-01T10:00:00Z",
  groups: [
    {
      id: 0,
      label: "JWT config hardening",
      files: ["auth.ts"],
      hunks: ["auth.ts:45-62"],
      rawDiff: "@@ -45,5 +45,8 @@\n-const token = jwt.sign(p, s)\n+const token = jwt.sign(p, s, { expiresIn: '15m' })",
      concerns: ["no error handling on jwt.verify"],
      status: "pending",
    },
  ],
  summary: null,
}

beforeEach(() => {
  mkdirSync(".opencode", { recursive: true })
})

afterEach(() => {
  try { rmSync(SESSION_PATH) } catch {}
})

test("sessionExists returns false when no file", () => {
  expect(sessionExists()).toBe(false)
})

test("writeSession + loadSession round-trips correctly", () => {
  writeSession(testSession)
  expect(sessionExists()).toBe(true)
  const loaded = loadSession()
  expect(loaded.branch).toBe("feat/auth")
  expect(loaded.groups[0].label).toBe("JWT config hardening")
  expect(loaded.summary).toBeNull()
})

test("loadSession throws if file does not exist", () => {
  expect(() => loadSession()).toThrow()
})
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/session.test.ts
```

Expected: FAIL — "Cannot find module './session'".

**Step 3: Implement session.ts**

Create `src/session.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync } from "fs"
import type { SessionState } from "./types"

export const SESSION_PATH = ".opencode/review-session.json"

export function sessionExists(): boolean {
  return existsSync(SESSION_PATH)
}

export function loadSession(): SessionState {
  const raw = readFileSync(SESSION_PATH, "utf-8")
  return JSON.parse(raw) as SessionState
}

export function writeSession(state: SessionState): void {
  writeFileSync(SESSION_PATH, JSON.stringify(state, null, 2), "utf-8")
}
```

**Step 4: Run tests to verify they pass**

```bash
bun test src/session.test.ts
```

Expected: PASS — 3 tests, 0 failures.

**Step 5: Commit**

```bash
git add src/session.ts src/session.test.ts
git commit -m "feat: implement session state read/write"
```

---

### Task 3: Implement git.ts (Diff Parsing)

**Files:**
- Create: `src/git.ts`
- Create: `src/git.test.ts`
- Create: `src/fixtures/sample.diff`

**Step 1: Create a fixture diff file**

Create `src/fixtures/sample.diff`:

```diff
diff --git a/auth.ts b/auth.ts
index 1234567..abcdefg 100644
--- a/auth.ts
+++ b/auth.ts
@@ -45,7 +45,12 @@ class AuthService {
   async createToken(payload: Payload): Promise<string> {
-    const token = jwt.sign(payload, this.secret)
+    const token = jwt.sign(payload, this.secret, {
+      expiresIn: '15m',
+      algorithm: 'HS256'
+    })
     return token
   }
diff --git a/api.ts b/api.ts
index 9876543..fedcba9 100644
--- a/api.ts
+++ b/api.ts
@@ -89,6 +89,11 @@ export async function fetchUser(id: string) {
-  const result = await fetch(`/users/${id}`)
+  const result = await fetchWithRetry(`/users/${id}`, {
+    maxAttempts: 3,
+    backoff: exponential({ base: 500 })
+  })
   return result.json()
 }
```

**Step 2: Write failing tests**

Create `src/git.test.ts`:

```typescript
import { expect, test } from "bun:test"
import { parseHunks } from "./git"
import { readFileSync } from "fs"

const sampleDiff = readFileSync("src/fixtures/sample.diff", "utf-8")

test("parseHunks returns one hunk per @@ block", () => {
  const hunks = parseHunks(sampleDiff)
  expect(hunks).toHaveLength(2)
})

test("parseHunks extracts file name correctly", () => {
  const hunks = parseHunks(sampleDiff)
  expect(hunks[0].file).toBe("auth.ts")
  expect(hunks[1].file).toBe("api.ts")
})

test("parseHunks extracts start line from @@ header", () => {
  const hunks = parseHunks(sampleDiff)
  expect(hunks[0].startLine).toBe(45)
  expect(hunks[1].startLine).toBe(89)
})

test("parseHunks includes raw hunk content", () => {
  const hunks = parseHunks(sampleDiff)
  expect(hunks[0].content).toContain("expiresIn")
  expect(hunks[1].content).toContain("fetchWithRetry")
})

test("parseHunks returns empty array for empty diff", () => {
  expect(parseHunks("")).toHaveLength(0)
})
```

**Step 3: Run to verify failure**

```bash
bun test src/git.test.ts
```

Expected: FAIL — "Cannot find module './git'".

**Step 4: Implement parseHunks in git.ts**

Create `src/git.ts`:

```typescript
import type { Hunk } from "./types"

export function parseHunks(rawDiff: string): Hunk[] {
  if (!rawDiff.trim()) return []

  const hunks: Hunk[] = []
  const lines = rawDiff.split("\n")

  let currentFile = ""
  let currentHunkLines: string[] = []
  let startLine = 0
  let endLine = 0
  let inHunk = false

  for (const line of lines) {
    // New file header
    if (line.startsWith("diff --git")) {
      if (inHunk && currentHunkLines.length > 0) {
        hunks.push({
          file: currentFile,
          startLine,
          endLine,
          content: currentHunkLines.join("\n"),
        })
        currentHunkLines = []
        inHunk = false
      }
      // Extract filename: "diff --git a/foo.ts b/foo.ts" → "foo.ts"
      const match = line.match(/diff --git a\/(.+) b\//)
      currentFile = match ? match[1] : ""
      continue
    }

    // Hunk header: @@ -45,7 +45,12 @@
    if (line.startsWith("@@")) {
      if (inHunk && currentHunkLines.length > 0) {
        hunks.push({
          file: currentFile,
          startLine,
          endLine,
          content: currentHunkLines.join("\n"),
        })
        currentHunkLines = []
      }
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      startLine = match ? parseInt(match[1], 10) : 0
      endLine = startLine
      inHunk = true
      currentHunkLines = [line]
      continue
    }

    if (inHunk) {
      currentHunkLines.push(line)
      if (!line.startsWith("-")) endLine++
    }
  }

  if (inHunk && currentHunkLines.length > 0) {
    hunks.push({ file: currentFile, startLine, endLine, content: currentHunkLines.join("\n") })
  }

  return hunks
}

export async function createReviewWorktree(branch: string): Promise<string> {
  const safeBranch = branch.replace(/\//g, "-")
  const path = `.opencode/worktrees/review-${safeBranch}`
  const result = await Bun.spawn(["git", "worktree", "add", path, branch]).exited
  if (result !== 0) throw new Error(`Failed to create worktree for branch: ${branch}`)
  return path
}

export async function getDiff(
  worktreePath: string,
  base: string,
  focus?: string[]
): Promise<string> {
  const args = ["git", "-C", worktreePath, "diff", base, "--unified=3", "--"]
  if (focus?.length) args.push(...focus.map((f) => `${f}/**`))
  const proc = Bun.spawn(args, { stdout: "pipe" })
  await proc.exited
  return new Response(proc.stdout).text()
}

export async function removeWorktree(path: string): Promise<void> {
  await Bun.spawn(["git", "worktree", "remove", "--force", path]).exited
}
```

**Step 5: Run tests**

```bash
bun test src/git.test.ts
```

Expected: PASS — 5 tests, 0 failures.

**Step 6: Commit**

```bash
git add src/git.ts src/git.test.ts src/fixtures/sample.diff
git commit -m "feat: implement diff parsing and worktree management"
```

---

### Task 4: Implement grouper.ts (LLM Semantic Grouping)

**Files:**
- Create: `src/grouper.ts`
- Create: `src/grouper.test.ts`

**Step 1: Write failing tests**

Create `src/grouper.test.ts`:

```typescript
import { expect, test, mock } from "bun:test"
import { groupHunks, groupByFile } from "./grouper"
import type { Hunk } from "./types"

const hunks: Hunk[] = [
  { file: "auth.ts", startLine: 45, endLine: 62, content: "@@ auth hunk @@\n+jwt.sign" },
  { file: "config.ts", startLine: 12, endLine: 15, content: "@@ config hunk @@\n+secret: env.JWT_SECRET" },
  { file: "api.ts", startLine: 89, endLine: 103, content: "@@ api hunk @@\n+fetchWithRetry" },
]

test("groupByFile groups hunks by filename", () => {
  const groups = groupByFile(hunks)
  expect(groups).toHaveLength(3)
  expect(groups[0].files).toEqual(["auth.ts"])
  expect(groups[0].label).toBe("Changes in auth.ts")
  expect(groups[0].status).toBe("pending")
  expect(groups[0].id).toBe(0)
})

test("groupByFile sets rawDiff from hunk content", () => {
  const groups = groupByFile(hunks)
  expect(groups[0].rawDiff).toContain("jwt.sign")
})

test("groupByFile sets empty concerns array", () => {
  const groups = groupByFile(hunks)
  expect(groups[0].concerns).toEqual([])
})

test("groupHunks falls back to groupByFile on LLM error", async () => {
  const failingLLM = async (_prompt: string) => {
    throw new Error("LLM timeout")
  }
  const groups = await groupHunks(hunks, "deep", failingLLM)
  expect(groups).toHaveLength(3)
  expect(groups[0].files).toEqual(["auth.ts"])
})

test("groupHunks uses LLM response when valid", async () => {
  const llmResponse = JSON.stringify({
    groups: [
      {
        label: "JWT config hardening",
        hunkIndices: [0, 1],
        concerns: ["no error handling on jwt.verify"],
      },
      {
        label: "Retry logic",
        hunkIndices: [2],
        concerns: [],
      },
    ],
  })
  const mockLLM = async (_prompt: string) => llmResponse
  const groups = await groupHunks(hunks, "deep", mockLLM)
  expect(groups).toHaveLength(2)
  expect(groups[0].label).toBe("JWT config hardening")
  expect(groups[0].files).toEqual(["auth.ts", "config.ts"])
  expect(groups[0].concerns).toEqual(["no error handling on jwt.verify"])
  expect(groups[1].label).toBe("Retry logic")
})
```

**Step 2: Run to verify failure**

```bash
bun test src/grouper.test.ts
```

Expected: FAIL — "Cannot find module './grouper'".

**Step 3: Implement grouper.ts**

Create `src/grouper.ts`:

```typescript
import type { Hunk, Group, Depth } from "./types"

export type LLMCaller = (prompt: string) => Promise<string>

interface LLMGroupResult {
  groups: Array<{
    label: string
    hunkIndices: number[]
    concerns: string[]
  }>
}

function buildGroupingPrompt(hunks: Hunk[], depth: Depth): string {
  const depthInstruction =
    depth === "skim"
      ? "Flag only high-severity concerns (security issues, missing error handling on critical paths). Skip trivial or obvious changes."
      : "Explain architectural rationale where relevant. Note patterns and alternatives that could have been chosen."

  const hunkList = hunks
    .map(
      (h, i) =>
        `Hunk ${i} [${h.file}:${h.startLine}-${h.endLine}]:\n${h.content}`
    )
    .join("\n\n---\n\n")

  return `You are analyzing a git diff. Group the hunks below into semantically related clusters.

Rules:
- Max 4 hunks per group
- Max ~80 lines of diff per group
- Each group needs: a short label (5-8 words), the hunk indices it contains, and any concerns
- Concerns: missing error handling, no tests for new logic, potential security issues, breaking changes
- ${depthInstruction}

Return ONLY valid JSON matching this schema exactly:
{
  "groups": [
    { "label": "string", "hunkIndices": [0, 1], "concerns": ["string"] }
  ]
}

Hunks:
${hunkList}`
}

export function groupByFile(hunks: Hunk[]): Group[] {
  return hunks.map((hunk, id) => ({
    id,
    label: `Changes in ${hunk.file}`,
    files: [hunk.file],
    hunks: [`${hunk.file}:${hunk.startLine}-${hunk.endLine}`],
    rawDiff: hunk.content,
    concerns: [],
    status: "pending" as const,
  }))
}

export async function groupHunks(
  hunks: Hunk[],
  depth: Depth,
  llm: LLMCaller
): Promise<Group[]> {
  try {
    const prompt = buildGroupingPrompt(hunks, depth)
    const raw = await llm(prompt)

    // Extract JSON — LLM may wrap in markdown fences
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error("No JSON found in LLM response")

    const parsed = JSON.parse(jsonMatch[0]) as LLMGroupResult

    return parsed.groups.map((g, id) => {
      const groupHunks = g.hunkIndices.map((i) => hunks[i])
      const files = [...new Set(groupHunks.map((h) => h.file))]
      const hunkRefs = groupHunks.map((h) => `${h.file}:${h.startLine}-${h.endLine}`)
      const rawDiff = groupHunks.map((h) => h.content).join("\n\n")

      return {
        id,
        label: g.label,
        files,
        hunks: hunkRefs,
        rawDiff,
        concerns: g.concerns,
        status: "pending" as const,
      }
    })
  } catch (err) {
    console.warn(`[learn-review] LLM grouping failed (${err}), falling back to file-based grouping`)
    return groupByFile(hunks)
  }
}
```

**Step 4: Run tests**

```bash
bun test src/grouper.test.ts
```

Expected: PASS — 5 tests, 0 failures.

**Step 5: Commit**

```bash
git add src/grouper.ts src/grouper.test.ts
git commit -m "feat: implement LLM semantic grouping with file-based fallback"
```

---

### Task 5: Implement index.ts (Plugin Orchestration)

> **Note:** Before implementing this task, inspect the opencode plugin API in your fork at `packages/opencode/src/plugin/`. The exact types for `OpenCodePlugin`, the event shape for `session.message`, and the HTTP client interface for posting messages will be there. Update the import paths and types below to match what you find.

**Files:**
- Modify: `src/index.ts`
- Create: `src/index.test.ts`

**Step 1: Write failing tests**

Create `src/index.test.ts`:

```typescript
import { expect, test, mock } from "bun:test"
import { parseParams, buildChunkMessage } from "./index"
import type { Group } from "./types"

test("parseParams extracts depth from token", () => {
  const params = parseParams("BEGIN_LEARN_REVIEW depth=deep focus=auth,api resume=false base=main branch=feat/auth")
  expect(params.depth).toBe("deep")
  expect(params.focus).toEqual(["auth", "api"])
  expect(params.resume).toBe(false)
  expect(params.base).toBe("main")
  expect(params.branch).toBe("feat/auth")
})

test("parseParams defaults to deep when depth missing", () => {
  const params = parseParams("BEGIN_LEARN_REVIEW base=main branch=feat/x")
  expect(params.depth).toBe("deep")
  expect(params.focus).toEqual([])
  expect(params.resume).toBe(false)
})

const group: Group = {
  id: 1,
  label: "JWT config hardening",
  files: ["auth.ts", "config.ts"],
  hunks: ["auth.ts:45-62"],
  rawDiff: "@@ -45 +45 @@\n-old\n+new",
  concerns: ["no error handling on jwt.verify"],
  status: "in_progress",
}

test("buildChunkMessage includes group label and index", () => {
  const msg = buildChunkMessage(group, 5)
  expect(msg).toContain("Group 2/5")
  expect(msg).toContain("JWT config hardening")
})

test("buildChunkMessage includes raw diff in fenced block", () => {
  const msg = buildChunkMessage(group, 5)
  expect(msg).toContain("```diff")
  expect(msg).toContain("-old\n+new")
})

test("buildChunkMessage lists concerns", () => {
  const msg = buildChunkMessage(group, 5)
  expect(msg).toContain("no error handling on jwt.verify")
})

test("buildChunkMessage omits concerns section when empty", () => {
  const noConcerns = { ...group, concerns: [] }
  const msg = buildChunkMessage(noConcerns, 5)
  expect(msg).not.toContain("Concerns:")
})
```

**Step 2: Run to verify failure**

```bash
bun test src/index.test.ts
```

Expected: FAIL — "parseParams is not exported from './index'".

**Step 3: Implement index.ts**

Replace `src/index.ts`:

```typescript
import { parseHunks, createReviewWorktree, getDiff, removeWorktree } from "./git"
import { groupHunks } from "./grouper"
import { loadSession, writeSession, sessionExists, SESSION_PATH } from "./session"
import type { Group, ReviewParams, SessionState } from "./types"

// ── Exported helpers (also used in tests) ────────────────────────────────────

export function parseParams(token: string): ReviewParams {
  const get = (key: string) => {
    const match = token.match(new RegExp(`${key}=([^\\s]+)`))
    return match ? match[1] : undefined
  }

  const focusRaw = get("focus")
  return {
    depth: (get("depth") as ReviewParams["depth"]) ?? "deep",
    focus: focusRaw && focusRaw !== "all" ? focusRaw.split(",") : [],
    resume: get("resume") === "true",
    base: get("base") ?? "main",
    branch: get("branch") ?? "HEAD",
  }
}

export function buildChunkMessage(group: Group, total: number): string {
  const concernsSection =
    group.concerns.length > 0
      ? `\n**Concerns:** ${group.concerns.join("; ")}`
      : ""

  return `[Review Plugin] Group ${group.id + 1}/${total}: **${group.label}**
Files: ${group.files.join(", ")}

\`\`\`diff
${group.rawDiff}
\`\`\`${concernsSection}`
}

// ── Plugin ────────────────────────────────────────────────────────────────────

// NOTE: Replace `any` with the actual opencode plugin types from your fork.
// Look in packages/opencode/src/plugin/ for the OpenCodePlugin interface.
export default function learnReviewPlugin(opencode: any) {
  opencode.on("session.message", async (event: { content: string; sessionId: string }) => {
    const { content, sessionId } = event

    if (content.includes("BEGIN_LEARN_REVIEW")) {
      const line = content.split("\n").find((l: string) => l.startsWith("BEGIN_LEARN_REVIEW"))
      if (!line) return
      await startSession(parseParams(line), sessionId, opencode)
      return
    }

    if (content.trim() === "ADVANCE_CHUNK") {
      await advanceChunk(sessionId, opencode)
      return
    }
  })
}

async function startSession(params: ReviewParams, sessionId: string, opencode: any) {
  if (params.resume && sessionExists()) {
    const session = loadSession()
    if (session.branch === params.branch) {
      const next = session.groups.find((g) => g.status !== "completed")
      if (next) {
        next.status = "in_progress"
        writeSession(session)
        await injectChunk(next, session.groups.length, sessionId, opencode)
        return
      }
    }
  }

  // Create isolated worktree for the branch under review
  const worktreePath = await createReviewWorktree(params.branch)

  // Get raw diff from worktree
  const rawDiff = await getDiff(worktreePath, params.base, params.focus)

  if (!rawDiff.trim()) {
    await injectSystemMessage(
      `No changes found between \`${params.branch}\` and \`${params.base}\`.`,
      sessionId,
      opencode
    )
    await removeWorktree(worktreePath)
    return
  }

  // LLM grouping — pass opencode's LLM client as the caller
  const hunks = parseHunks(rawDiff)
  const llmCaller = (prompt: string) => opencode.llm.complete(prompt)
  const groups = await groupHunks(hunks, params.depth, llmCaller)

  groups[0].status = "in_progress"

  const session: SessionState = {
    branch: params.branch,
    base: params.base,
    depth: params.depth,
    focus: params.focus,
    worktreePath,
    createdAt: new Date().toISOString(),
    groups,
    summary: null,
  }
  writeSession(session)

  await injectChunk(groups[0], groups.length, sessionId, opencode)
}

async function advanceChunk(sessionId: string, opencode: any) {
  if (!sessionExists()) return

  const session = loadSession()
  const current = session.groups.find((g) => g.status === "in_progress")
  if (!current) return

  current.status = "completed"
  const next = session.groups.find((g) => g.status === "pending")

  if (next) {
    next.status = "in_progress"
    writeSession(session)
    await injectChunk(next, session.groups.length, sessionId, opencode)
  } else {
    writeSession(session)
    await injectSummaryPrompt(session, sessionId, opencode)
  }
}

async function injectChunk(group: Group, total: number, sessionId: string, opencode: any) {
  await injectSystemMessage(buildChunkMessage(group, total), sessionId, opencode)
}

async function injectSummaryPrompt(session: SessionState, sessionId: string, opencode: any) {
  const reviewed = session.groups.map((g) => `- ${g.label}`).join("\n")
  await injectSystemMessage(
    `[Review Plugin] All ${session.groups.length} groups reviewed.\n\nGroups covered:\n${reviewed}\n\nPlease provide a summary of what was reviewed and the key takeaways for the engineer.`,
    sessionId,
    opencode
  )
}

// NOTE: Replace with the actual opencode HTTP client method from your fork.
// Typically: opencode.client.post(`/session/${sessionId}/message`, { ... })
async function injectSystemMessage(content: string, sessionId: string, opencode: any) {
  await opencode.client.post(`/session/${sessionId}/message`, {
    role: "system",
    content,
  })
}
```

**Step 4: Run tests**

```bash
bun test src/index.test.ts
```

Expected: PASS — 6 tests, 0 failures.

**Step 5: Run all tests together**

```bash
bun test
```

Expected: PASS — all tests across all files.

**Step 6: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: implement plugin orchestration (sentinel tokens, chunk injection)"
```

---

### Task 6: Wire Plugin Into Your opencode Fork

> This task happens in your opencode fork repo (`~/opencode-fork`), not the plugin repo.

**Files (in opencode fork):**
- Modify: `packages/opencode/src/plugin/index.ts` (or wherever plugins are registered)
- Modify: `packages/opencode/package.json` (add local plugin dep)

**Step 1: Link the plugin package locally**

```bash
cd /Users/apple/ai-projects/learn-review
bun link

cd ~/opencode-fork
bun link opencode-learn-review
```

**Step 2: Find where plugins are registered**

```bash
grep -r "plugin" ~/opencode-fork/packages/opencode/src --include="*.ts" -l
```

Look for a file that registers plugins or has a plugin loading mechanism. Read it before making changes.

**Step 3: Register the plugin**

In the plugin registration file (exact code depends on what you find in Step 2 — adapt accordingly):

```typescript
import learnReviewPlugin from "opencode-learn-review"

// Add to the plugin list alongside existing plugins:
learnReviewPlugin(opencode)
```

**Step 4: Copy config files to your opencode fork's user config**

```bash
cp /Users/apple/ai-projects/learn-review/config/commands/learn-review.md \
   ~/opencode-fork/.opencode/commands/

cp /Users/apple/ai-projects/learn-review/config/agents/review-agent.md \
   ~/opencode-fork/.opencode/agents/
```

**Step 5: Build and run opencode in dev mode**

```bash
cd ~/opencode-fork
bun run dev
```

In the opencode TUI, type:

```
/learn-review --depth deep --base main
```

Expected: Pre-analysis pass runs (~5-10s), first semantic group appears in chat as a formatted diff block, review agent presents it and asks what you'd like to understand.

**Step 6: Test the advance flow**

In the review session, say "next". Expected: `ADVANCE_CHUNK` emitted by agent, plugin injects next group.

**Step 7: Commit in the opencode fork**

```bash
cd ~/opencode-fork
git add .opencode/ packages/opencode/
git commit -m "feat: integrate opencode-learn-review plugin"
```

---

### Task 7: Integration Test With a Fixture Git Repo

**Files (in plugin repo):**
- Create: `src/integration/fixture-repo.ts`
- Create: `src/integration/full-flow.test.ts`

**Step 1: Write a helper that creates a fixture git repo**

Create `src/integration/fixture-repo.ts`:

```typescript
import { mkdirSync, writeFileSync, rmSync } from "fs"

export async function createFixtureRepo(): Promise<string> {
  const dir = `/tmp/learn-review-fixture-${Date.now()}`
  mkdirSync(dir, { recursive: true })

  // Init repo
  await Bun.spawn(["git", "init"], { cwd: dir }).exited
  await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: dir }).exited
  await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: dir }).exited

  // Initial commit on main
  writeFileSync(`${dir}/auth.ts`, `export function login(user: string) {\n  return user\n}\n`)
  await Bun.spawn(["git", "add", "."], { cwd: dir }).exited
  await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: dir }).exited

  // Feature branch with changes
  await Bun.spawn(["git", "checkout", "-b", "feat/auth-update"], { cwd: dir }).exited
  writeFileSync(
    `${dir}/auth.ts`,
    `import jwt from 'jsonwebtoken'\n\nexport function login(user: string) {\n  return jwt.sign({ user }, process.env.SECRET!, { expiresIn: '15m' })\n}\n`
  )
  await Bun.spawn(["git", "add", "."], { cwd: dir }).exited
  await Bun.spawn(["git", "commit", "-m", "use jwt"], { cwd: dir }).exited

  // Switch back to main (plugin will create worktree from here)
  await Bun.spawn(["git", "checkout", "main"], { cwd: dir }).exited

  return dir
}

export async function cleanFixtureRepo(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}
```

**Step 2: Write integration test**

Create `src/integration/full-flow.test.ts`:

```typescript
import { expect, test, afterEach } from "bun:test"
import { createFixtureRepo, cleanFixtureRepo } from "./fixture-repo"
import { parseHunks, createReviewWorktree, getDiff, removeWorktree } from "../git"
import { groupByFile } from "../grouper"
import { writeSession, loadSession, sessionExists } from "../session"
import { rmSync } from "fs"

let fixtureDir = ""
let worktreePath = ""

afterEach(async () => {
  if (worktreePath) {
    try { await removeWorktree(worktreePath) } catch {}
  }
  if (fixtureDir) await cleanFixtureRepo(fixtureDir)
  try { rmSync(".opencode/review-session.json") } catch {}
})

test("full pre-analysis flow: fixture repo → hunks → groups → session file", async () => {
  fixtureDir = await createFixtureRepo()

  // Simulate: plugin creates worktree for feature branch
  const originalCwd = process.cwd()
  process.chdir(fixtureDir)

  worktreePath = await createReviewWorktree("feat/auth-update")
  const rawDiff = await getDiff(worktreePath, "main")

  expect(rawDiff).toContain("jwt")
  expect(rawDiff).toContain("auth.ts")

  const hunks = parseHunks(rawDiff)
  expect(hunks.length).toBeGreaterThan(0)
  expect(hunks[0].file).toBe("auth.ts")

  const groups = groupByFile(hunks)
  expect(groups[0].status).toBe("pending")

  groups[0].status = "in_progress"
  writeSession({
    branch: "feat/auth-update",
    base: "main",
    depth: "deep",
    focus: [],
    worktreePath,
    createdAt: new Date().toISOString(),
    groups,
    summary: null,
  })

  expect(sessionExists()).toBe(true)
  const loaded = loadSession()
  expect(loaded.groups[0].status).toBe("in_progress")

  process.chdir(originalCwd)
}, 30_000) // 30s timeout for git operations
```

**Step 3: Run integration test**

```bash
bun test src/integration/full-flow.test.ts
```

Expected: PASS — 1 test. Confirms the full pipeline from fixture repo → worktree → diff → hunks → groups → session file works end-to-end.

**Step 4: Commit**

```bash
git add src/integration/
git commit -m "test: add integration test for full pre-analysis flow"
```

---

### Task 8: Final Polish & README

**Files:**
- Create: `README.md`

**Step 1: Run the full test suite one final time**

```bash
bun test
```

Expected: All tests pass, 0 failures.

**Step 2: Write minimal README**

Create `README.md`:

```markdown
# opencode-learn-review

Interactive code review learning mode for [opencode](https://opencode.ai).

## What it does

Turns code review into a learning session. Presents diff changes grouped
semantically, one chunk at a time, with Q&A and proactive explanations.

## Installation

1. Link the plugin into your opencode fork
2. Copy `config/commands/learn-review.md` → `.opencode/commands/`
3. Copy `config/agents/review-agent.md` → `.opencode/agents/`

## Usage

\`\`\`
/learn-review                          # review current branch vs main
/learn-review --depth skim             # flag concerns only
/learn-review --focus auth,api         # only review these directories
/learn-review --base develop           # diff against develop instead of main
/learn-review --resume                 # continue previous session
\`\`\`

## Design

See `docs/plans/2026-03-01-learn-review-design.md` for full architecture.
```

**Step 3: Final commit**

```bash
git add README.md
git commit -m "docs: add README"
```

---

## Implementation Order Summary

| Task | What | Tests |
|---|---|---|
| 1 | Types + test infra | Smoke test |
| 2 | session.ts | 3 unit tests |
| 3 | git.ts (diff parsing) | 5 unit tests |
| 4 | grouper.ts (LLM grouping) | 5 unit tests |
| 5 | index.ts (plugin orchestration) | 6 unit tests |
| 6 | Wire into opencode fork | Manual E2E |
| 7 | Integration test | 1 integration test |
| 8 | README | — |

## Key Unknowns to Resolve in Task 6

- Exact opencode plugin API types (inspect `packages/opencode/src/plugin/`)
- HTTP client method for posting messages to a session
- LLM client interface for the grouping call (`opencode.llm.complete` is an assumption)
- How plugins are registered (may be config-based or code-based)

These are marked with `// NOTE:` comments in `src/index.ts` so they're easy to find.

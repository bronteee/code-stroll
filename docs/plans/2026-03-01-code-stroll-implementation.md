# code-stroll Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a standalone plugin that turns code review into an interactive learning session — walking engineers through semantically grouped diff chunks with Q&A, proactive hooks, and concern flagging.

**Architecture:** A TypeScript/Bun plugin package (`code-stroll`) that registers a listener on the host's SSE message stream. Two sentinel tokens (`BEGIN_CODE_STROLL`, `ADVANCE_CHUNK`) coordinate between the command file, the review agent, and the plugin. A pre-analysis LLM pass groups diff hunks semantically before the session starts; state is persisted to `.opencode/review-session.json` to support `--resume`. The branch under review is diffed in an isolated git worktree so the current working directory is never disturbed.

**Tech Stack:** TypeScript, Bun (runtime + test runner), plugin API, `git` CLI via shell, host LLM client for grouping calls.

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
  version: 1
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

export interface SessionMessageEvent {
  content: string
  sessionId: string
}

export interface OpenCodeClient {
  post(path: string, body: { role: string; content: string }): Promise<void>
}

export interface OpenCodeLLM {
  complete(prompt: string): Promise<string>
}

export interface OpenCodePlugin {
  on(event: "session.message", handler: (event: SessionMessageEvent) => Promise<void>): void
  client: OpenCodeClient
  llm: OpenCodeLLM
}
```

**Step 3: Write a smoke test to verify imports work**

Create `src/types.test.ts`:

```typescript
import { expect, test } from "bun:test"
import type { SessionState } from "./types"

test("SessionState type is importable", () => {
  const s: SessionState = {
    version: 1,
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
  version: 1,
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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import path from "path"
import type { SessionState } from "./types"

export const SESSION_PATH = ".opencode/review-session.json"

const SESSION_VERSION = 1

export function sessionExists(): boolean {
  return existsSync(SESSION_PATH)
}

export function loadSession(): SessionState {
  const raw = readFileSync(SESSION_PATH, "utf-8")
  const parsed = JSON.parse(raw)
  if (parsed.version !== SESSION_VERSION) {
    throw new Error(
      `Session file version mismatch: expected ${SESSION_VERSION}, got ${parsed.version}. Delete ${SESSION_PATH} and start a new session.`
    )
  }
  return parsed as SessionState
}

export function writeSession(state: SessionState): void {
  mkdirSync(path.dirname(SESSION_PATH), { recursive: true })
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

test("parseHunks computes endLine from new-file hunk header", () => {
  const hunks = parseHunks(sampleDiff)
  // @@ -45,7 +45,12 @@ → startLine=45, endLine=56 (45+12-1)
  expect(hunks[0].startLine).toBe(45)
  expect(hunks[0].endLine).toBe(56)
  // @@ -89,6 +89,11 @@ → startLine=89, endLine=99 (89+11-1)
  expect(hunks[1].startLine).toBe(89)
  expect(hunks[1].endLine).toBe(99)
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
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
      startLine = match ? parseInt(match[1], 10) : 0
      const count = match?.[2] ? parseInt(match[2], 10) : 1
      endLine = startLine + count - 1
      inHunk = true
      currentHunkLines = [line]
      continue
    }

    if (inHunk) {
      currentHunkLines.push(line)
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
  const proc = Bun.spawn(["git", "worktree", "add", path, branch], { stderr: "pipe" })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`Failed to create worktree for branch '${branch}': ${stderr.trim()}`)
  }
  return path
}

export async function getDiff(
  worktreePath: string,
  base: string,
  focus?: string[]
): Promise<string> {
  const args = ["git", "-C", worktreePath, "diff", base, "--unified=3", "--"]
  if (focus?.length) args.push(...focus.map((f) => `${f}/**`))
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git diff failed: ${stderr.trim()}`)
  }
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

Expected: PASS — 6 tests, 0 failures.

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

const hunksWithDuplicateFile: Hunk[] = [
  { file: "auth.ts", startLine: 10, endLine: 20, content: "hunk1" },
  { file: "auth.ts", startLine: 45, endLine: 62, content: "hunk2" },
  { file: "api.ts", startLine: 89, endLine: 103, content: "hunk3" },
]

test("groupByFile aggregates multiple hunks in the same file", () => {
  const groups = groupByFile(hunksWithDuplicateFile)
  expect(groups).toHaveLength(2)  // 2 files, not 3 hunks
  expect(groups[0].label).toBe("Changes in auth.ts")
  expect(groups[0].rawDiff).toContain("hunk1")
  expect(groups[0].rawDiff).toContain("hunk2")
  expect(groups[1].label).toBe("Changes in api.ts")
})

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

test("groupHunks ignores out-of-bounds hunkIndices from LLM", async () => {
  const llmResponse = JSON.stringify({
    groups: [{ label: "Valid", hunkIndices: [0, 99], concerns: [] }],
  })
  const mockLLM = async (_prompt: string) => llmResponse
  const groups = await groupHunks(hunks, "deep", mockLLM)
  expect(groups).toHaveLength(1)
  expect(groups[0].files).toEqual(["auth.ts"]) // only index 0 is valid
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
  const byFile = new Map<string, Hunk[]>()
  for (const hunk of hunks) {
    const existing = byFile.get(hunk.file) ?? []
    existing.push(hunk)
    byFile.set(hunk.file, existing)
  }

  return Array.from(byFile.entries()).map(([file, fileHunks], id) => ({
    id,
    label: `Changes in ${file}`,
    files: [file],
    hunks: fileHunks.map((h) => `${h.file}:${h.startLine}-${h.endLine}`),
    rawDiff: fileHunks.map((h) => h.content).join("\n\n"),
    concerns: [],
    status: "pending" as const,
  }))
}

function extractJSON(raw: string): string {
  const stripped = raw.replace(/^```(?:json)?\s*/gm, "").replace(/^```\s*$/gm, "")
  const start = stripped.indexOf("{")
  if (start === -1) throw new Error("No JSON object found in LLM response")
  let depth = 0
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === "{") depth++
    if (stripped[i] === "}") depth--
    if (depth === 0) return stripped.slice(start, i + 1)
  }
  throw new Error("Unbalanced braces in LLM response")
}

export async function groupHunks(
  hunks: Hunk[],
  depth: Depth,
  llm: LLMCaller
): Promise<Group[]> {
  try {
    const prompt = buildGroupingPrompt(hunks, depth)
    const raw = await llm(prompt)

    const parsed = JSON.parse(extractJSON(raw)) as LLMGroupResult

    return parsed.groups
      .map((g, id) => {
        const validIndices = g.hunkIndices.filter(
          (i) => Number.isInteger(i) && i >= 0 && i < hunks.length
        )
        if (validIndices.length === 0) return null
        const groupHunks = validIndices.map((i) => hunks[i])
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
      .filter((g): g is Group => g !== null)
  } catch (err) {
    console.warn(`[code-stroll] LLM grouping failed (${err}), falling back to file-based grouping`)
    return groupByFile(hunks)
  }
}
```

**Step 4: Run tests**

```bash
bun test src/grouper.test.ts
```

Expected: PASS — 7 tests, 0 failures.

**Step 5: Commit**

```bash
git add src/grouper.ts src/grouper.test.ts
git commit -m "feat: implement LLM semantic grouping with file-based fallback"
```

---

### Task 5: Implement index.ts (Plugin Orchestration)

**Files:**
- Modify: `src/index.ts`
- Create: `src/index.test.ts`

**Step 1: Write failing tests**

Create `src/index.test.ts`:

```typescript
import { expect, test, mock } from "bun:test"
import { parseReviewCommand, buildChunkMessage } from "./index"
import type { Group } from "./types"

test("parseReviewCommand extracts depth from token", () => {
  const params = parseReviewCommand("BEGIN_CODE_STROLL depth=deep focus=auth,api resume=false base=main branch=feat/auth")
  expect(params.depth).toBe("deep")
  expect(params.focus).toEqual(["auth", "api"])
  expect(params.resume).toBe(false)
  expect(params.base).toBe("main")
  expect(params.branch).toBe("feat/auth")
})

test("parseReviewCommand defaults to deep when depth missing", () => {
  const params = parseReviewCommand("BEGIN_CODE_STROLL base=main branch=feat/x")
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

Expected: FAIL — "parseReviewCommand is not exported from './index'".

**Step 3: Implement index.ts**

Replace `src/index.ts`:

```typescript
import { parseHunks, createReviewWorktree, getDiff, removeWorktree } from "./git"
import { groupHunks } from "./grouper"
import { loadSession, writeSession, sessionExists, SESSION_PATH } from "./session"
import type { Group, ReviewParams, SessionState, OpenCodePlugin } from "./types"

// ── Exported helpers (also used in tests) ────────────────────────────────────

export function parseReviewCommand(token: string): ReviewParams {
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

export default function codeStrollPlugin(opencode: OpenCodePlugin) {
  opencode.on("session.message", async (event) => {
    const { content, sessionId } = event

    const beginLine = content.split("\n").find((l: string) => l.trimStart().startsWith("BEGIN_CODE_STROLL"))
    if (beginLine) {
      await startSession(parseReviewCommand(beginLine.trim()), sessionId, opencode)
      return
    }

    if (content.trim() === "ADVANCE_CHUNK") {
      await advanceChunk(sessionId, opencode)
      return
    }
  })
}

async function startSession(params: ReviewParams, sessionId: string, opencode: OpenCodePlugin) {
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
    version: 1,
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

async function advanceChunk(sessionId: string, opencode: OpenCodePlugin) {
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

async function injectChunk(group: Group, total: number, sessionId: string, opencode: OpenCodePlugin) {
  await injectSystemMessage(buildChunkMessage(group, total), sessionId, opencode)
}

async function injectSummaryPrompt(session: SessionState, sessionId: string, opencode: OpenCodePlugin) {
  const reviewed = session.groups.map((g) => `- ${g.label}`).join("\n")
  await injectSystemMessage(
    `[Review Plugin] All ${session.groups.length} groups reviewed.\n\nGroups covered:\n${reviewed}\n\nPlease provide a summary of what was reviewed and the key takeaways for the engineer.`,
    sessionId,
    opencode
  )
}

async function injectSystemMessage(content: string, sessionId: string, opencode: OpenCodePlugin) {
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

### Task 6: Integration Test With a Fixture Git Repo

**Files (in plugin repo):**
- Create: `src/integration/fixture-repo.ts`
- Create: `src/integration/full-flow.test.ts`

**Step 1: Write a helper that creates a fixture git repo**

Create `src/integration/fixture-repo.ts`:

```typescript
import { mkdirSync, writeFileSync, rmSync } from "fs"

export async function createFixtureRepo(): Promise<string> {
  const dir = `/tmp/code-stroll-fixture-${Date.now()}`
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
import { parseHunks, getDiff } from "../git"
import { groupByFile } from "../grouper"
import { writeSession, loadSession, sessionExists } from "../session"
import { rmSync } from "fs"

let fixtureDir = ""

afterEach(async () => {
  if (fixtureDir) await cleanFixtureRepo(fixtureDir)
  try { rmSync(".opencode/review-session.json") } catch {}
})

test("full pre-analysis flow: fixture repo → hunks → groups → session file", async () => {
  fixtureDir = await createFixtureRepo()

  // getDiff already accepts a cwd via its worktreePath arg — use fixtureDir directly
  const rawDiff = await getDiff(fixtureDir, "main..feat/auth-update")

  expect(rawDiff).toContain("jwt")
  expect(rawDiff).toContain("auth.ts")

  const hunks = parseHunks(rawDiff)
  expect(hunks.length).toBeGreaterThan(0)
  expect(hunks[0].file).toBe("auth.ts")

  const groups = groupByFile(hunks)
  expect(groups[0].status).toBe("pending")

  groups[0].status = "in_progress"
  writeSession({
    version: 1,
    branch: "feat/auth-update",
    base: "main",
    depth: "deep",
    focus: [],
    worktreePath: fixtureDir,
    createdAt: new Date().toISOString(),
    groups,
    summary: null,
  })

  expect(sessionExists()).toBe(true)
  const loaded = loadSession()
  expect(loaded.groups[0].status).toBe("in_progress")
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

### Task 7: Final Polish & README

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
# code-stroll

Interactive code review learning mode.

## What it does

Turns code review into a learning session. Presents diff changes grouped
semantically, one chunk at a time, with Q&A and proactive explanations.

## Installation

1. Copy `config/commands/code-stroll.md` → `.opencode/commands/`
2. Copy `config/agents/review-agent.md` → `.opencode/agents/`

## Usage

\`\`\`
/code-stroll                          # review current branch vs main
/code-stroll --depth skim             # flag concerns only
/code-stroll --focus auth,api         # only review these directories
/code-stroll --base develop           # diff against develop instead of main
/code-stroll --resume                 # continue previous session
\`\`\`

## Design

See `docs/plans/2026-03-01-code-stroll-design.md` for full architecture.
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
| 3 | git.ts (diff parsing) | 6 unit tests |
| 4 | grouper.ts (LLM grouping) | 7 unit tests |
| 5 | index.ts (plugin orchestration) | 6 unit tests |
| 6 | Integration test | 1 integration test |
| 7 | README | — |


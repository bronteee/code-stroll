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

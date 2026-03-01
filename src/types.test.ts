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

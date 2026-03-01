import { expect, test } from "bun:test"
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

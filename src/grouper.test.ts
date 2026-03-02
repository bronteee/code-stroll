import { expect, test } from "bun:test"
import { groupByFile } from "./grouper"
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
  expect(groups).toHaveLength(2)
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

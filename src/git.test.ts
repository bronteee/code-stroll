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

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

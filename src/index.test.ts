import { expect, test } from "bun:test"
import plugin from "./index"

const mockCtx = {
  client: {} as any,
  project: {} as any,
  directory: "/tmp/test-project",
  worktree: "/tmp/test-project",
  serverUrl: new URL("http://localhost:3000"),
  $: {} as any,
}

test("plugin returns tool hooks", async () => {
  const hooks = await plugin(mockCtx)
  expect(hooks.tool).toBeDefined()
  expect(hooks.tool!.code_stroll_start).toBeDefined()
  expect(hooks.tool!.code_stroll_cleanup).toBeDefined()
})

test("code_stroll_start tool has correct description", async () => {
  const hooks = await plugin(mockCtx)
  const startTool = hooks.tool!.code_stroll_start
  expect(startTool.description).toContain("code-stroll")
})

test("code_stroll_cleanup tool has correct description", async () => {
  const hooks = await plugin(mockCtx)
  const cleanupTool = hooks.tool!.code_stroll_cleanup
  expect(cleanupTool.description).toContain("Clean up")
})

test("code_stroll_cleanup returns message when no session", async () => {
  const hooks = await plugin(mockCtx)
  const result = await hooks.tool!.code_stroll_cleanup.execute({}, {} as any)
  expect(result).toContain("No active session")
})

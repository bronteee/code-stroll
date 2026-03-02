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

export async function createReviewWorktree(branch: string, baseDir?: string): Promise<string> {
  const safeBranch = branch.replace(/\//g, "-")
  const worktreeDir = `${baseDir ?? "."}/.opencode/worktrees/review-${safeBranch}`
  const args = baseDir
    ? ["git", "-C", baseDir, "worktree", "add", worktreeDir, branch]
    : ["git", "worktree", "add", worktreeDir, branch]
  const proc = Bun.spawn(args, { stderr: "pipe" })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`Failed to create worktree for branch '${branch}': ${stderr.trim()}`)
  }
  return worktreeDir
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

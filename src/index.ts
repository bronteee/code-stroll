import { tool } from "@opencode-ai/plugin/tool"
import type { Plugin } from "@opencode-ai/plugin"
import { parseHunks, createReviewWorktree, getDiff, removeWorktree } from "./git"
import { loadSession, writeSession, sessionExists } from "./session"
import type { Hunk, SessionState } from "./types"

function formatHunks(hunks: Hunk[]): string {
  if (hunks.length === 0) return "No hunks found."
  return hunks
    .map(
      (h, i) =>
        `### Hunk ${i + 1}: ${h.file} (lines ${h.startLine}–${h.endLine})\n\`\`\`diff\n${h.content}\n\`\`\``
    )
    .join("\n\n")
}

const plugin: Plugin = async (ctx) => ({
  tool: {
    code_stroll_start: tool({
      description:
        "Start or resume a code-stroll review session. Returns all diff hunks for the agent to semantically group and present.",
      args: {
        branch: tool.schema
          .string()
          .default("HEAD")
          .describe("Branch to review"),
        base: tool.schema
          .string()
          .default("main")
          .describe("Base branch to diff against"),
        focus: tool.schema
          .string()
          .default("")
          .describe("Comma-separated directories to focus on, or empty for all"),
        depth: tool.schema
          .enum(["skim", "deep"])
          .default("deep")
          .describe("Review depth: skim (concerns only) or deep (full rationale)"),
        resume: tool.schema
          .string()
          .default("false")
          .describe("Set to 'true' to resume a previous session"),
      },
      async execute(args) {
        const focusDirs =
          args.focus && args.focus !== "all"
            ? args.focus.split(",").map((s) => s.trim())
            : []

        // Resume existing session if requested
        if (args.resume === "true" && sessionExists()) {
          const session = loadSession()
          if (session.branch === args.branch) {
            return `Resumed session for branch \`${session.branch}\` (${session.groups.length} groups).\n\nDepth: ${session.depth}\n\n${formatHunks(
              session.groups.flatMap((g) =>
                g.hunks.map((ref) => {
                  const [file, range] = ref.split(":")
                  const [start, end] = range.split("-").map(Number)
                  return { file, startLine: start, endLine: end, content: g.rawDiff }
                })
              )
            )}`
          }
        }

        // Create worktree and get diff
        const worktreePath = await createReviewWorktree(args.branch, ctx.directory)
        const rawDiff = await getDiff(worktreePath, args.base, focusDirs.length > 0 ? focusDirs : undefined)

        if (!rawDiff.trim()) {
          await removeWorktree(worktreePath)
          return `No changes found between \`${args.branch}\` and \`${args.base}\`.`
        }

        const hunks = parseHunks(rawDiff)

        // Save session for potential resume
        const { groupByFile } = await import("./grouper")
        const groups = groupByFile(hunks)
        const session: SessionState = {
          version: 1,
          branch: args.branch,
          base: args.base,
          depth: args.depth,
          focus: focusDirs,
          worktreePath,
          createdAt: new Date().toISOString(),
          groups,
          summary: null,
        }
        writeSession(session)

        return `Started code-stroll for \`${args.branch}\` vs \`${args.base}\`.\nDepth: **${args.depth}**\nHunks: **${hunks.length}**\nWorktree: \`${worktreePath}\`\n\n${formatHunks(hunks)}\n\nGroup these hunks semantically and present them one group at a time for review.`
      },
    }),

    code_stroll_cleanup: tool({
      description:
        "Clean up the code-stroll session: remove the worktree and delete the session file.",
      args: {},
      async execute() {
        if (!sessionExists()) {
          return "No active session to clean up."
        }
        const session = loadSession()
        try {
          await removeWorktree(session.worktreePath)
        } catch {
          // Worktree may already be gone
        }
        const { rmSync } = await import("fs")
        const { SESSION_PATH } = await import("./session")
        try {
          rmSync(SESSION_PATH)
        } catch {
          // Session file may already be gone
        }
        return `Cleaned up session for branch \`${session.branch}\`. Worktree removed.`
      },
    }),
  },
})

export default plugin

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

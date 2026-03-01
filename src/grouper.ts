import type { Hunk, Group, Depth } from "./types"

export type LLMCaller = (prompt: string) => Promise<string>

interface LLMGroupResult {
  groups: Array<{
    label: string
    hunkIndices: number[]
    concerns: string[]
  }>
}

function buildGroupingPrompt(hunks: Hunk[], depth: Depth): string {
  const depthInstruction =
    depth === "skim"
      ? "Flag only high-severity concerns (security issues, missing error handling on critical paths). Skip trivial or obvious changes."
      : "Explain architectural rationale where relevant. Note patterns and alternatives that could have been chosen."

  const hunkList = hunks
    .map(
      (h, i) =>
        `Hunk ${i} [${h.file}:${h.startLine}-${h.endLine}]:\n${h.content}`
    )
    .join("\n\n---\n\n")

  return `You are analyzing a git diff. Group the hunks below into semantically related clusters.

Rules:
- Max 4 hunks per group
- Max ~80 lines of diff per group
- Each group needs: a short label (5-8 words), the hunk indices it contains, and any concerns
- Concerns: missing error handling, no tests for new logic, potential security issues, breaking changes
- ${depthInstruction}

Return ONLY valid JSON matching this schema exactly:
{
  "groups": [
    { "label": "string", "hunkIndices": [0, 1], "concerns": ["string"] }
  ]
}

Hunks:
${hunkList}`
}

export function groupByFile(hunks: Hunk[]): Group[] {
  const byFile = new Map<string, Hunk[]>()
  for (const hunk of hunks) {
    const existing = byFile.get(hunk.file) ?? []
    existing.push(hunk)
    byFile.set(hunk.file, existing)
  }

  return Array.from(byFile.entries()).map(([file, fileHunks], id) => ({
    id,
    label: `Changes in ${file}`,
    files: [file],
    hunks: fileHunks.map((h) => `${h.file}:${h.startLine}-${h.endLine}`),
    rawDiff: fileHunks.map((h) => h.content).join("\n\n"),
    concerns: [],
    status: "pending" as const,
  }))
}

function extractJSON(raw: string): string {
  const stripped = raw.replace(/^```(?:json)?\s*/gm, "").replace(/^```\s*$/gm, "")
  const start = stripped.indexOf("{")
  if (start === -1) throw new Error("No JSON object found in LLM response")
  let depth = 0
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === "{") depth++
    if (stripped[i] === "}") depth--
    if (depth === 0) return stripped.slice(start, i + 1)
  }
  throw new Error("Unbalanced braces in LLM response")
}

export async function groupHunks(
  hunks: Hunk[],
  depth: Depth,
  llm: LLMCaller
): Promise<Group[]> {
  try {
    const prompt = buildGroupingPrompt(hunks, depth)
    const raw = await llm(prompt)

    const parsed = JSON.parse(extractJSON(raw)) as LLMGroupResult

    return parsed.groups
      .map((g, id) => {
        const validIndices = g.hunkIndices.filter(
          (i) => Number.isInteger(i) && i >= 0 && i < hunks.length
        )
        if (validIndices.length === 0) return null
        const groupHunks = validIndices.map((i) => hunks[i])
        const files = [...new Set(groupHunks.map((h) => h.file))]
        const hunkRefs = groupHunks.map((h) => `${h.file}:${h.startLine}-${h.endLine}`)
        const rawDiff = groupHunks.map((h) => h.content).join("\n\n")

        return {
          id,
          label: g.label,
          files,
          hunks: hunkRefs,
          rawDiff,
          concerns: g.concerns,
          status: "pending" as const,
        }
      })
      .filter((g): g is Group => g !== null)
  } catch (err) {
    console.warn(`[code-stroll] LLM grouping failed (${err}), falling back to file-based grouping`)
    return groupByFile(hunks)
  }
}

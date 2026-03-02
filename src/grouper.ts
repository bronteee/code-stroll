import type { Hunk, Group } from "./types"

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

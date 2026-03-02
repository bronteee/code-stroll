export type Depth = "skim" | "deep"
export type GroupStatus = "pending" | "in_progress" | "completed"

export interface Hunk {
  file: string
  startLine: number
  endLine: number
  content: string
}

export interface Group {
  id: number
  label: string
  files: string[]
  hunks: string[]        // "file:startLine-endLine"
  rawDiff: string
  concerns: string[]
  status: GroupStatus
}

export interface SessionState {
  version: 1
  branch: string
  base: string
  depth: Depth
  focus: string[]
  worktreePath: string
  createdAt: string
  groups: Group[]
  summary: string | null
}

export interface ReviewParams {
  depth: Depth
  focus: string[]
  resume: boolean
  base: string
  branch: string
}

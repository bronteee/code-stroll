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

export interface SessionMessageEvent {
  content: string
  sessionId: string
}

export interface OpenCodeClient {
  post(path: string, body: { role: string; content: string }): Promise<void>
}

export interface OpenCodeLLM {
  complete(prompt: string): Promise<string>
}

export interface OpenCodePlugin {
  on(event: "session.message", handler: (event: SessionMessageEvent) => Promise<void>): void
  client: OpenCodeClient
  llm: OpenCodeLLM
}

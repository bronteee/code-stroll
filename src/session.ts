import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import path from "path"
import type { SessionState } from "./types"

export const SESSION_PATH = ".opencode/review-session.json"

const SESSION_VERSION = 1

export function sessionExists(): boolean {
  return existsSync(SESSION_PATH)
}

export function loadSession(): SessionState {
  const raw = readFileSync(SESSION_PATH, "utf-8")
  const parsed = JSON.parse(raw)
  if (parsed.version !== SESSION_VERSION) {
    throw new Error(
      `Session file version mismatch: expected ${SESSION_VERSION}, got ${parsed.version}. Delete ${SESSION_PATH} and start a new session.`
    )
  }
  return parsed as SessionState
}

export function writeSession(state: SessionState): void {
  mkdirSync(path.dirname(SESSION_PATH), { recursive: true })
  writeFileSync(SESSION_PATH, JSON.stringify(state, null, 2), "utf-8")
}

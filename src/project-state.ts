import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type IndexerStateStatus = "NO_PROJECT" | "INDEXING" | "READY" | "FAILED"

export interface IndexerState {
  status: IndexerStateStatus
  startedAt: string | null
  completedAt: string | null
  error: string | null
  indexedFiles: number
  missingDeps: string[]
}

export const DEFAULT_STATE: IndexerState = {
  status: "NO_PROJECT",
  startedAt: null,
  completedAt: null,
  error: null,
  indexedFiles: 0,
  missingDeps: [],
}

function getProjectDir(projectDir: string): string {
  return join(projectDir, ".opencode", "doodba-dev")
}

export function ensureProjectDir(projectDir: string): void {
  const dir = getProjectDir(projectDir)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function getProjectDbPath(projectDir: string): string {
  return join(getProjectDir(projectDir), "index.db")
}

export function readState(projectDir: string): IndexerState {
  ensureProjectDir(projectDir)
  const statePath = join(getProjectDir(projectDir), "state.json")
  if (!existsSync(statePath)) {
    return { ...DEFAULT_STATE }
  }
  try {
    const content = readFileSync(statePath, "utf-8")
    return { ...DEFAULT_STATE, ...JSON.parse(content) }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

export function updateState(projectDir: string, partial: Partial<IndexerState>): void {
  ensureProjectDir(projectDir)
  const statePath = join(getProjectDir(projectDir), "state.json")
  const current = readState(projectDir)
  const next = { ...current, ...partial }
  writeFileSync(statePath, JSON.stringify(next, null, 2))
}

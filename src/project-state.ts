import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type IndexerStateStatus = "NO_PROJECT" | "INDEXING" | "READY" | "FAILED";

export interface IndexerState {
  status: IndexerStateStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  indexedFiles: number;
  missingDeps: string[];
}

export const STATE_FILE_NAME = "state.json";
export const DB_FILE_NAME = "index.db";
export const PLUGIN_STATE_SUBDIR = ".opencode/doodba-dev";

export const DEFAULT_STATE: Readonly<IndexerState> = Object.freeze({
  status: "NO_PROJECT",
  startedAt: null,
  completedAt: null,
  error: null,
  indexedFiles: 0,
  missingDeps: [],
});

function getPluginDir(projectDir: string): string {
  return join(projectDir, PLUGIN_STATE_SUBDIR);
}

export function ensureProjectDir(projectDir: string): void {
  const dir = getPluginDir(projectDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function getProjectDbPath(projectDir: string): string {
  return join(getPluginDir(projectDir), DB_FILE_NAME);
}

export function readState(projectDir: string): IndexerState {
  ensureProjectDir(projectDir);
  const statePath = join(getPluginDir(projectDir), STATE_FILE_NAME);
  if (!existsSync(statePath)) {
    return { ...DEFAULT_STATE };
  }
  try {
    const content = readFileSync(statePath, "utf-8");
    return { ...DEFAULT_STATE, ...JSON.parse(content) };
  } catch (err) {
    console.warn(`Failed to parse state file at ${statePath}:`, err);
    return { ...DEFAULT_STATE };
  }
}

export function updateState(projectDir: string, partial: Partial<IndexerState>): void {
  const stateDir = getPluginDir(projectDir);
  const statePath = join(stateDir, STATE_FILE_NAME);
  const tmpPath = statePath + ".tmp";

  // Ensure directory exists
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  // Read current state
  let current = { ...DEFAULT_STATE };
  if (existsSync(statePath)) {
    try {
      const content = readFileSync(statePath, "utf-8");
      current = { ...DEFAULT_STATE, ...JSON.parse(content) };
    } catch (e) {
      console.warn(`[project-state] failed to read state.json, starting fresh: ${e}`);
    }
  }

  // Merge update
  const next = { ...current, ...partial };

  // Write to temp file
  writeFileSync(tmpPath, JSON.stringify(next, null, 2));

  // Atomic rename (POSIX)
  try {
    renameSync(tmpPath, statePath);
  } catch (e) {
    try {
      unlinkSync(tmpPath);
    } catch (cleanupErr) {
      console.warn(`[project-state] failed to clean up temp file: ${cleanupErr}`);
    }
    throw new Error(`[project-state] failed to update state: ${e}`, { cause: e });
  }
}

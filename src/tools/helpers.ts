import { type ToolResult } from "@opencode-ai/plugin";
import { homedir } from "node:os";
import { DoodbaIndexDatabase } from "../database";
import { globalDatabaseCache } from "../database-cache";
import { findDoodbaRoot } from "../doodba-detector";
import { getProjectDbPath, readState, type IndexerState } from "../project-state";

export const ENTITY_TYPES = ["model", "field", "view", "method", "menuitem", "xml_id"] as const;

export const REF_ENTITY_TYPES = ["model", "field", "view", "method"] as const;

export const BLOCKED_ROOTS = ["/", homedir()];

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatResponse(
  status: IndexerState["status"],
  results: unknown,
  message?: string
): ToolResult {
  return {
    output: message ?? JSON.stringify(results ?? []),
    metadata: { _doodba_status: status, results: results ?? [], _message: message },
  };
}

export function resolveProjectDir(contextDir: string): string {
  return findDoodbaRoot(contextDir) ?? contextDir;
}

export type ReadyResult =
  | { ready: true; projectDir: string }
  | { ready: false; status: IndexerState["status"]; message: string };

const STATUS_MESSAGES: Record<Exclude<IndexerState["status"], "READY">, string> = {
  NO_PROJECT:
    "No Doodba project detected (.copier-answers.yml not found). If you have a Doodba project, make sure you are in its directory or run /doodba-setup.",
  INDEXING:
    "The indexer is building the database for the first time (2-5 min). Please try again in a few moments.",
  FAILED: "",
};

export function checkReady(contextDir: string): ReadyResult {
  const projectDir = resolveProjectDir(contextDir);
  const state = readState(projectDir);
  if (state.status === "READY") return { ready: true, projectDir };
  const message =
    state.status === "FAILED"
      ? `Indexing error: ${state.error ?? "unknown"}. Run /doodba-setup to retry.`
      : STATUS_MESSAGES[state.status];
  return { ready: false, status: state.status, message };
}

export async function withDbAsync<T>(
  projectDir: string,
  fn: (db: DoodbaIndexDatabase) => Promise<T>
): Promise<T> {
  const dbPath = getProjectDbPath(projectDir);
  // Try to get from cache
  let db = globalDatabaseCache.get(dbPath);
  if (!db) {
    // Cache miss: create new connection
    db = new DoodbaIndexDatabase(dbPath);
    globalDatabaseCache.set(dbPath, db);
  }
  // Use connection
  return fn(db);
}

export async function executeWithReadyCheck<T>(
  contextDir: string,
  emptyResult: T,
  fn: (db: DoodbaIndexDatabase, projectDir: string) => T | Promise<T>
): Promise<ToolResult> {
  const ready = checkReady(contextDir);
  if (!ready.ready) return formatResponse(ready.status, emptyResult, ready.message);
  try {
    const result = await withDbAsync(ready.projectDir, (db) =>
      Promise.resolve(fn(db, ready.projectDir))
    );
    return formatResponse("READY", result);
  } catch (e) {
    return formatResponse("FAILED", emptyResult, toErrorMessage(e));
  }
}

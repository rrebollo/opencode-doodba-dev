import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedItem } from "./types";
import { PythonBatchParser } from "./python-batch";

const PYTHON_BINARY = process.env.OPENCODE_PYTHON ?? "python3";
const PYTHON_SUBPROCESS_TIMEOUT_MS = 10_000;
// Timeout rationale: Python AST extraction is typically < 1s for most files,
// but we allow 10s to handle large modules with extensive class hierarchies

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "python_ast_extract.py");

let batchParser: PythonBatchParser | null = null;

/**
 * Start the batch Python parser process.
 * Should be called once at the beginning of an indexing session.
 */
export async function startBatchParser(): Promise<void> {
  if (batchParser) return;
  batchParser = new PythonBatchParser(PYTHON_BINARY);
  await batchParser.start();
}

/**
 * Stop the batch Python parser process.
 * Should be called once at the end of an indexing session.
 */
export async function stopBatchParser(): Promise<void> {
  if (batchParser) {
    await batchParser.stop();
    batchParser = null;
  }
}

/**
 * Parse a Python file using the batch parser if available,
 * otherwise falls back to per-file subprocess.
 * Falls back to empty array if Python is unavailable or the script fails.
 * Fixes the class body boundary bug present in the regex parser.
 */
export async function parsePythonAst(filePath: string, module: string): Promise<ParsedItem[]> {
  // Try batch parser first
  if (batchParser) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const result = await batchParser.parse({
        file_path: filePath,
        content,
        module_name: module,
      });
      if (result.error) {
        console.warn(`[python-ast] Batch parser failed for ${filePath}:`, result.error);
        return [];
      }
      return Array.isArray(result.items) ? result.items : [];
    } catch (err) {
      console.warn(`[python-ast] Batch parser error for ${filePath}:`, err);
      // Fall through to fallback
    }
  }

  // Fallback to per-file spawn
  return parsePythonFallback(filePath, module);
}

/**
 * Parse a Python file using per-file subprocess (fallback).
 * Used when batch parser is not available.
 */
function parsePythonFallback(filePath: string, module: string): ParsedItem[] {
  try {
    const result = spawnSync(PYTHON_BINARY, [SCRIPT_PATH, filePath, module], {
      encoding: "utf-8",
      timeout: PYTHON_SUBPROCESS_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) {
      if (result.stderr?.trim()) {
        console.warn(`[python-ast] Python script failed for ${filePath}:`, result.stderr.trim());
      }
      return [];
    }
    const parsed = JSON.parse(result.stdout.trim() || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

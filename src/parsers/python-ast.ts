import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedItem } from "./types";

const PYTHON_BINARY = process.env.OPENCODE_PYTHON ?? "python3";
const PYTHON_SUBPROCESS_TIMEOUT_MS = 10_000;
// Timeout rationale: Python AST extraction is typically < 1s for most files,
// but we allow 10s to handle large modules with extensive class hierarchies

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "python_ast_extract.py");

/**
 * Parse a Python file using Python's ast module (via subprocess).
 * Falls back to empty array if Python is unavailable or the script fails.
 * Fixes the class body boundary bug present in the regex parser.
 */
export function parsePythonAst(filePath: string, module: string): ParsedItem[] {
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

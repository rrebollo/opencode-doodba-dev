import { spawnSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { PythonItem } from "./python-regex"

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "python_ast_extract.py",
)

/**
 * Parse a Python file using Python's ast module (via subprocess).
 * Falls back to empty array if Python is unavailable or the script fails.
 * Fixes the class body boundary bug present in the regex parser.
 */
export function parsePythonAst(filePath: string, module: string): PythonItem[] {
  try {
    const result = spawnSync("python3", [SCRIPT_PATH, filePath, module], {
      encoding: "utf-8",
      timeout: 10_000,
    })
    if (result.error || result.status !== 0) {
      return []
    }
    const parsed = JSON.parse(result.stdout.trim() || "[]")
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

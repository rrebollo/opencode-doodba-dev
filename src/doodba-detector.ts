import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"

const DOODBA_MARKER_FILE = ".copier-answers.yml"
const DOODBA_SRC_DIR = join("odoo", "custom", "src")
const MANIFEST_FILENAME = "__manifest__.py"
const MAX_WALK_DEPTH = 20

/**
 * Walk up parent directories looking for DOODBA_MARKER_FILE.
 * Returns the directory containing it, or null if not found within MAX_WALK_DEPTH levels.
 */
export function findDoodbaRoot(startDir: string): string | null {
  let current = startDir
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    if (existsSync(join(current, DOODBA_MARKER_FILE))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      // Reached filesystem root
      break
    }
    current = parent
  }
  return null
}

/**
 * Derive Odoo module source paths from a Doodba project root.
 * Returns only subdirectories of odoo/custom/src/ that contain a __manifest__.py,
 * excluding hidden directories (those starting with '.').
 */
export function getSourcePaths(doodbaRoot: string): string[] {
  const srcDir = join(doodbaRoot, DOODBA_SRC_DIR)
  if (!existsSync(srcDir)) {
    return []
  }
  const paths: string[] = []
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith(".")) continue
    const full = join(srcDir, entry.name)
    if (existsSync(join(full, MANIFEST_FILENAME))) {
      paths.push(full)
    }
  }
  return paths
}

import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Walk up parent directories looking for .copier-answers.yml.
 * Returns the directory containing it, or null if not found.
 */
export function findDoodbaRoot(startDir: string): string | null {
  let current = startDir
  while (true) {
    if (existsSync(join(current, ".copier-answers.yml"))) {
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
 * Derive source paths from a Doodba root.
 * Lists all subdirectories of odoo/custom/src/.
 */
export function getSourcePaths(doodbaRoot: string): string[] {
  const srcDir = join(doodbaRoot, "odoo", "custom", "src")
  if (!existsSync(srcDir)) {
    return []
  }
  const paths: string[] = []
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const full = join(srcDir, entry.name)
    if (entry.isDirectory()) {
      paths.push(full)
    }
  }
  return paths
}

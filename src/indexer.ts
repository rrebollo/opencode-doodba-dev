import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { extname, join } from "node:path"
import { DoodbaIndexDatabase } from "./database"
import { discoverModules, findCycles, resolveDependencyOrder } from "./dependency-tree"
import { parseCsv } from "./parsers/csv"
import { parseManifest } from "./parsers/manifest"
import { parsePythonAst as parsePython } from "./parsers/python-ast"
import { parseXml } from "./parsers/xml"

// 64-bit collision resistance (16 hex chars = ~64 bits)
const HASH_LENGTH = 16

type FileParser = (filePath: string, module: string) => Array<{
  itemType: string
  name: string
  parentName: string | null
  module: string
  attributes: Record<string, any>
  references?: Array<{
    filePath: string
    lineNumber: number
    referenceType: string
    context?: string | null
  }>
}>

interface IndexFilesOptions {
  full: boolean | undefined
  mod: { name: string; depth: number }
  db: DoodbaIndexDatabase
  counters: { indexed: number; skipped: number; errors: number }
  dependencyDepth?: number
}

function indexFiles(
  files: string[],
  parser: FileParser,
  opts: IndexFilesOptions,
): void {
  for (const f of files) {
    const hash = fileHash(f)
    const existing = opts.db.getFileHash(f)
    if (!opts.full && existing === hash) {
      opts.counters.skipped++
      continue
    }
    try {
      const items = parser(f, opts.mod.name)
      for (const item of items) {
        const itemId = opts.db.upsertItem(
          item.itemType,
          item.name,
          item.parentName,
          item.module,
          item.attributes,
          opts.dependencyDepth ?? opts.mod.depth,
        )
        for (const ref of item.references ?? []) {
          opts.db.upsertReference(itemId, ref.filePath, ref.lineNumber, ref.referenceType, ref.context ?? null)
        }
      }
      opts.db.upsertFileMetadata(f, opts.mod.name, hash)
      opts.counters.indexed++
    } catch (err) {
      opts.counters.errors++
      console.warn(`[indexer] Error parsing ${f}:`, err)
    }
  }
}

function fileHash(filePath: string): string {
  try {
    const content = readFileSync(filePath)
    return createHash("sha256").update(content).digest("hex").slice(0, HASH_LENGTH)
  } catch {
    return ""
  }
}

function walkDir(dir: string, exts: string[]): string[] {
  const results: string[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        results.push(...walkDir(full, exts))
      } else if (entry.isFile() && exts.includes(extname(entry.name))) {
        results.push(full)
      }
    }
  } catch (err) {
    console.warn("[indexer] Skipped directory:", err)
  }
  return results
}

export interface IndexOptions {
  rootPaths: string[]
  modules?: string[]
  full?: boolean
  dbPath?: string
}

export function indexModules(opts: IndexOptions): {
  indexed: number
  skipped: number
  errors: number
  missingDeps: string[]
} {
  if (!opts.dbPath) {
    throw new Error("dbPath is required for indexing Doodba modules")
  }
  const dbPath = opts.dbPath
  const db = new DoodbaIndexDatabase(dbPath)
  const counters = { indexed: 0, skipped: 0, errors: 0 }
  const missingDepsSet = new Set<string>()

  try {
    const allModules = discoverModules(opts.rootPaths)
    const cycleResult = findCycles(allModules)
    if (cycleResult.hasCycles) {
      console.warn(
        `[indexer] Cyclic dependencies detected — indexing will proceed but dependency order may be incorrect. Cycles:`,
        cycleResult.cycles.map((c) => c.join(" → ")).join(", "),
      )
    }
    const ordered = resolveDependencyOrder(allModules)
    const toIndex = opts.modules ? ordered.filter((m) => opts.modules?.includes(m.name)) : ordered

    for (const mod of toIndex) {
      // Check for missing dependencies
      for (const dep of mod.depends) {
        if (!allModules.has(dep)) {
          missingDepsSet.add(dep)
        }
      }
      if (opts.full) db.clearModule(mod.name)

      // Index manifest
      const manifestPath = join(mod.path, "__manifest__.py")
      parseManifest(manifestPath, mod.name)

      db.beginTransaction()
      try {
        // Python files
        indexFiles(walkDir(mod.path, [".py"]), parsePython, { full: opts.full, mod, db, counters, dependencyDepth: mod.depth })

        // XML files
        indexFiles(walkDir(mod.path, [".xml"]), parseXml, { full: opts.full, mod, db, counters })

        // CSV files
        indexFiles(walkDir(mod.path, [".csv"]), parseCsv, { full: opts.full, mod, db, counters })

        db.commitTransaction()
      } catch (e) {
        db.rollbackTransaction()
        counters.errors++
        console.warn(`[indexer] Transaction failed for module ${mod.name}:`, e)
      }
    }
  } finally {
    db.close()
  }

  return { indexed: counters.indexed, skipped: counters.skipped, errors: counters.errors, missingDeps: Array.from(missingDepsSet) }
}

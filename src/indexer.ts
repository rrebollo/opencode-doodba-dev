import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { extname, join } from "node:path"
import { DoodbaIndexDatabase } from "./database"
import { discoverModules, findCycles, resolveDependencyOrder } from "./dependency-tree"
import { parseCsv } from "./parsers/csv"
import { parseManifest } from "./parsers/manifest"
import { parsePythonAst as parsePython } from "./parsers/python-ast"
import { parseXml } from "./parsers/xml"

function fileHash(filePath: string): string {
  try {
    const content = readFileSync(filePath)
    return createHash("sha256").update(content).digest("hex").slice(0, 16)
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
    console.warn("[indexer] Skipped directory (permission error or missing):", err)
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
  let indexed = 0
  let skipped = 0
  let errors = 0
  const missingDeps: string[] = []

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
        if (!allModules.has(dep) && !missingDeps.includes(dep)) {
          missingDeps.push(dep)
        }
      }
      if (opts.full) db.clearModule(mod.name)

      // Index manifest
      const manifestPath = join(mod.path, "__manifest__.py")
      const _manifest = parseManifest(manifestPath, mod.name)

      db.beginTransaction()
      try {
        // Python files
        for (const f of walkDir(mod.path, [".py"])) {
          const hash = fileHash(f)
          const existing = db.getFileHash(f)
          if (!opts.full && existing === hash) {
            skipped++
            continue
          }
          try {
            const items = parsePython(f, mod.name)
            for (const item of items) {
              const itemId = db.upsertItem(
                item.itemType,
                item.name,
                item.parentName,
                item.module,
                item.attributes,
                mod.depth,
              )
              for (const ref of item.references ?? []) {
                db.upsertReference(itemId, ref.filePath, ref.lineNumber, ref.referenceType, ref.context ?? null)
              }
            }
            db.upsertFileMetadata(f, mod.name, hash)
            indexed++
          } catch {
            errors++
          }
        }

        // XML files
        for (const f of walkDir(mod.path, [".xml"])) {
          const hash = fileHash(f)
          const existing = db.getFileHash(f)
          if (!opts.full && existing === hash) {
            skipped++
            continue
          }
          try {
            const items = parseXml(f, mod.name)
            for (const item of items) {
              const itemId = db.upsertItem(item.itemType, item.name, item.parentName, item.module, item.attributes)
              for (const ref of item.references ?? []) {
                db.upsertReference(itemId, ref.filePath, ref.lineNumber, ref.referenceType, ref.context ?? null)
              }
            }
            db.upsertFileMetadata(f, mod.name, hash)
            indexed++
          } catch {
            errors++
          }
        }

        // CSV files
        for (const f of walkDir(mod.path, [".csv"])) {
          const hash = fileHash(f)
          const existing = db.getFileHash(f)
          if (!opts.full && existing === hash) {
            skipped++
            continue
          }
          try {
            const items = parseCsv(f, mod.name)
            for (const item of items) {
              const itemId = db.upsertItem(item.itemType, item.name, item.parentName, item.module, item.attributes)
              for (const ref of item.references ?? []) {
                db.upsertReference(itemId, ref.filePath, ref.lineNumber, ref.referenceType, ref.context ?? null)
              }
            }
            db.upsertFileMetadata(f, mod.name, hash)
            indexed++
          } catch {
            errors++
          }
        }

        db.commitTransaction()
      } catch (e) {
        db.rollbackTransaction()
        errors++
        console.warn(`[indexer] Transaction failed for module ${mod.name}:`, e)
      }
    }
  } finally {
    db.close()
  }

  return { indexed, skipped, errors, missingDeps }
}

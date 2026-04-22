import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { DoodbaIndexDatabase } from "./database";
import { discoverModules, findCycles, resolveDependencyOrder } from "./dependency-tree";
import { parseCsv } from "./parsers/csv";
import { parseManifest } from "./parsers/manifest";
import {
  parsePythonAst as parsePython,
  startBatchParser,
  stopBatchParser,
} from "./parsers/python-ast";
import { parseXml } from "./parsers/xml";

// Directories never relevant to code indexing
const SKIP_DIRS = new Set([
  "static", // JS, SCSS, images
  "i18n", // .po/.pot translation files
  "__pycache__", // Python bytecode cache
  "node_modules", // NPM dependencies
  "setup", // OCA setup files
  "readme", // Documentation dirs
  "doc", // Documentation
  "migrations", // Migration scripts (configurable later)
]);

interface ModuleFiles {
  py: string[];
  xml: string[];
  csv: string[];
}

function walkModule(dir: string, visited = new Set<number>()): ModuleFiles {
  const result: ModuleFiles = { py: [], xml: [], csv: [] };

  let realDir: string;
  let inode: number;
  try {
    realDir = realpathSync(dir);
    inode = statSync(realDir).ino;
  } catch (e) {
    console.warn(`[walkModule] cannot stat ${dir}: ${e}`);
    return result;
  }

  if (visited.has(inode)) {
    console.warn(`[walkModule] cycle detected at ${dir} (inode ${inode})`);
    return result;
  }
  visited.add(inode);

  try {
    const entries = readdirSync(realDir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(realDir, entry.name);

      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !entry.name.startsWith(".") &&
        !SKIP_DIRS.has(entry.name)
      ) {
        const sub = walkModule(full, visited);
        result.py.push(...sub.py);
        result.xml.push(...sub.xml);
        result.csv.push(...sub.csv);
      } else if (!entry.isDirectory()) {
        if (full.endsWith(".py")) result.py.push(full);
        else if (full.endsWith(".xml")) result.xml.push(full);
        else if (full.endsWith(".csv")) result.csv.push(full);
      }
    }
  } catch (e) {
    console.warn(`[walkModule] failed to read ${realDir}: ${e}`);
  }

  return result;
}

// 64-bit collision resistance (16 hex chars = ~64 bits)
const HASH_LENGTH = 16;

type FileParser = (
  filePath: string,
  module: string
) =>
  | Array<{
      itemType: string;
      name: string;
      parentName: string | null;
      module: string;
      attributes: Record<string, unknown>;
      references?: Array<{
        filePath: string;
        lineNumber: number;
        referenceType: string;
        context?: string | null;
      }>;
    }>
  | Promise<
      Array<{
        itemType: string;
        name: string;
        parentName: string | null;
        module: string;
        attributes: Record<string, unknown>;
        references?: Array<{
          filePath: string;
          lineNumber: number;
          referenceType: string;
          context?: string | null;
        }>;
      }>
    >;

interface IndexFilesOptions {
  full: boolean | undefined;
  mod: { name: string; depth: number };
  db: DoodbaIndexDatabase;
  counters: { indexed: number; skipped: number; errors: number };
  dependencyDepth?: number;
}

async function indexFiles(
  files: string[],
  parser: FileParser,
  opts: IndexFilesOptions
): Promise<void> {
  for (const f of files) {
    const hash = fileHash(f);
    const existing = opts.db.getFileHash(f);
    if (!opts.full && existing === hash) {
      opts.counters.skipped++;
      continue;
    }
    try {
      const items = await Promise.resolve(parser(f, opts.mod.name));
      for (const item of items) {
        const itemId = opts.db.upsertItem(
          item.itemType,
          item.name,
          item.parentName,
          item.module,
          item.attributes,
          opts.dependencyDepth ?? opts.mod.depth
        );
        for (const ref of item.references ?? []) {
          opts.db.upsertReference(
            itemId,
            ref.filePath,
            ref.lineNumber,
            ref.referenceType,
            ref.context ?? null
          );
        }
      }
      opts.db.upsertFileMetadata(f, opts.mod.name, hash);
      opts.counters.indexed++;
    } catch (err) {
      opts.counters.errors++;
      console.warn(`[indexer] Error parsing ${f}:`, err);
    }
  }
}

function fileHash(filePath: string): string {
  try {
    const content = readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex").slice(0, HASH_LENGTH);
  } catch {
    return "";
  }
}

export interface IndexOptions {
  rootPaths: string[];
  modules?: string[];
  full?: boolean;
  dbPath?: string;
}

export async function indexModules(opts: IndexOptions): Promise<{
  indexed: number;
  skipped: number;
  errors: number;
  missingDeps: string[];
}> {
  if (!opts.dbPath) {
    throw new Error("dbPath is required for indexing Doodba modules");
  }
  const dbPath = opts.dbPath;
  const db = new DoodbaIndexDatabase(dbPath);
  const counters = { indexed: 0, skipped: 0, errors: 0 };
  const missingDepsSet = new Set<string>();

  await startBatchParser();
  try {
    const allModules = discoverModules(opts.rootPaths);
    const cycleResult = findCycles(allModules);
    if (cycleResult.hasCycles) {
      console.warn(
        `[indexer] Cyclic dependencies detected — indexing will proceed but dependency order may be incorrect. Cycles:`,
        cycleResult.cycles.map((c) => c.join(" → ")).join(", ")
      );
    }
    const ordered = resolveDependencyOrder(allModules);
    const toIndex = opts.modules ? ordered.filter((m) => opts.modules?.includes(m.name)) : ordered;

    for (const mod of toIndex) {
      // Check for missing dependencies
      for (const dep of mod.depends) {
        if (!allModules.has(dep)) {
          missingDepsSet.add(dep);
        }
      }
      if (opts.full) db.clearModule(mod.name);

      // Index manifest
      const manifestPath = join(mod.path, "__manifest__.py");
      parseManifest(manifestPath, mod.name);

      db.beginTransaction();
      try {
        const files = walkModule(mod.path);

        // Python files
        await indexFiles(files.py, parsePython, {
          full: opts.full,
          mod,
          db,
          counters,
          dependencyDepth: mod.depth,
        });

        // XML files
        await indexFiles(files.xml, parseXml, { full: opts.full, mod, db, counters });

        // CSV files
        await indexFiles(files.csv, parseCsv, { full: opts.full, mod, db, counters });

        db.commitTransaction();
      } catch (e) {
        db.rollbackTransaction();
        counters.errors++;
        console.warn(`[indexer] Transaction failed for module ${mod.name}:`, e);
      }
    }
  } finally {
    await stopBatchParser();
    db.close();
  }

  return {
    indexed: counters.indexed,
    skipped: counters.skipped,
    errors: counters.errors,
    missingDeps: Array.from(missingDepsSet),
  };
}

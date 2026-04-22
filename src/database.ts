import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

// Schema is backward compatible with the Python odoo-indexer CLI (aiosqlite version).
// Column names and types are intentionally identical to support existing user databases.

const DEFAULT_SEARCH_LIMIT = 50

interface RawIndexedItemRow {
  id: number
  item_type: string
  name: string
  parent_name: string | null
  module: string
  attributes: string | null
  dependency_depth: number
}

interface RawReferenceRow {
  id: number
  item_id: number
  file_path: string
  line_number: number
  reference_type: string
  context: string | null
}

const INDEXED_ITEM_COLUMNS = "id, item_type, name, parent_name, module, attributes, dependency_depth"

export interface IndexedItem {
  id: number
  itemType: string
  name: string
  parentName: string | null
  module: string
  attributes: Record<string, any>
  dependencyDepth: number
}

export interface ItemReference {
  id: number
  itemId: number
  filePath: string
  lineNumber: number
  referenceType: string
  context: string | null
}

export interface SearchOptions {
  query?: string
  itemType?: string
  parentName?: string
  module?: string
  limit?: number
}

function mapRow(r: RawIndexedItemRow): IndexedItem {
  return {
    id: r.id,
    itemType: r.item_type,
    name: r.name,
    parentName: r.parent_name,
    module: r.module,
    attributes: r.attributes ? JSON.parse(r.attributes) : {},
    dependencyDepth: r.dependency_depth,
  }
}

function mapReferenceRow(r: RawReferenceRow): ItemReference {
  return {
    id: r.id,
    itemId: r.item_id,
    filePath: r.file_path,
    lineNumber: r.line_number,
    referenceType: r.reference_type,
    context: r.context,
  }
}

export class DoodbaIndexDatabase {
  private db: Database

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("PRAGMA foreign_keys = ON")
    this.initSchema()
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS indexed_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_type TEXT NOT NULL,
        name TEXT NOT NULL,
        parent_name TEXT,
        module TEXT NOT NULL,
        attributes TEXT,
        dependency_depth INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(item_type, name, parent_name, module)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS item_references (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        reference_type TEXT NOT NULL,
        context TEXT,
        FOREIGN KEY (item_id) REFERENCES indexed_items(id) ON DELETE CASCADE
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS file_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT UNIQUE NOT NULL,
        module TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        last_indexed TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
    for (const idx of [
      "CREATE INDEX IF NOT EXISTS idx_item_type ON indexed_items(item_type)",
      "CREATE INDEX IF NOT EXISTS idx_item_name ON indexed_items(name)",
      "CREATE INDEX IF NOT EXISTS idx_item_parent ON indexed_items(parent_name)",
      "CREATE INDEX IF NOT EXISTS idx_item_module ON indexed_items(module)",
      "CREATE INDEX IF NOT EXISTS idx_item_type_name ON indexed_items(item_type, name)",
      "CREATE INDEX IF NOT EXISTS idx_dependency_depth ON indexed_items(dependency_depth)",
      "CREATE INDEX IF NOT EXISTS idx_ref_item_id ON item_references(item_id)",
      "CREATE INDEX IF NOT EXISTS idx_ref_file ON item_references(file_path)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ref_unique ON item_references(item_id, file_path, line_number, reference_type)",
      "CREATE INDEX IF NOT EXISTS idx_file_path ON file_metadata(file_path)",
    ])
      this.db.run(idx)
  }

  upsertItem(
    itemType: string,
    name: string,
    parentName: string | null,
    module: string,
    attributes: Record<string, any>,
    dependencyDepth = 0,
  ): number {
    const attrsJson = JSON.stringify(attributes)
    this.db.run(
      `INSERT INTO indexed_items (item_type, name, parent_name, module, attributes, dependency_depth)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_type, name, parent_name, module) DO UPDATE SET attributes=excluded.attributes, dependency_depth=excluded.dependency_depth`,
      [itemType, name, parentName, module, attrsJson, dependencyDepth],
    )
    const row = this.db
      .query<{ id: number }, any[]>(
        "SELECT id FROM indexed_items WHERE item_type=? AND name=? AND parent_name IS ? AND module=?",
      )
      .get(itemType, name, parentName, module)
    return row?.id ?? 0
  }

  upsertReference(
    itemId: number,
    filePath: string,
    lineNumber: number,
    referenceType: string,
    context: string | null,
  ): void {
    this.db.run(
      "INSERT OR IGNORE INTO item_references (item_id, file_path, line_number, reference_type, context) VALUES (?, ?, ?, ?, ?)",
      [itemId, filePath, lineNumber, referenceType, context],
    )
  }

  search(opts: SearchOptions): IndexedItem[] {
    const conditions: string[] = []
    const params: any[] = []
    if (opts.query) {
      conditions.push("(name LIKE ? OR parent_name LIKE ?)")
      params.push(`%${opts.query}%`, `%${opts.query}%`)
    }
    if (opts.itemType) {
      conditions.push("item_type = ?")
      params.push(opts.itemType)
    }
    if (opts.parentName) {
      conditions.push("parent_name = ?")
      params.push(opts.parentName)
    }
    if (opts.module) {
      conditions.push("module = ?")
      params.push(opts.module)
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT
    const query = `SELECT ${INDEXED_ITEM_COLUMNS} FROM indexed_items ${where} LIMIT ${limit}`
    const rows = this.db.query<RawIndexedItemRow, any[]>(query).all(...params)
    return rows.map(mapRow)
  }

  getDetails(name: string, itemType: string): IndexedItem | null {
    const row = this.db
      .query<RawIndexedItemRow, any[]>(`SELECT ${INDEXED_ITEM_COLUMNS} FROM indexed_items WHERE name=? AND item_type=? LIMIT 1`)
      .get(name, itemType)
    if (!row) return null
    return mapRow(row)
  }

  listModules(): string[] {
    return this.db
      .query<{ module: string }, []>("SELECT DISTINCT module FROM indexed_items ORDER BY module")
      .all()
      .map((r) => r.module)
  }

  moduleStats(module: string): Record<string, number> {
    const rows = this.db
      .query<any, [string]>(
        "SELECT item_type, COUNT(*) as cnt FROM indexed_items WHERE module=? GROUP BY item_type",
      )
      .all(module)
    return Object.fromEntries(rows.map((r) => [r.item_type, r.cnt]))
  }

  findRefs(name: string, itemType: string): ItemReference[] {
    const rows = this.db
      .query<RawReferenceRow, any[]>(
        "SELECT r.id, r.item_id, r.file_path, r.line_number, r.reference_type, r.context FROM item_references r JOIN indexed_items i ON r.item_id=i.id WHERE i.name=? AND i.item_type=?",
      )
      .all(name, itemType)
    return rows.map(mapReferenceRow)
  }

  searchByAttr(
    itemType: string,
    filters: Record<string, any>,
    module?: string,
    limit = 50,
  ): IndexedItem[] {
    let sql = `SELECT ${INDEXED_ITEM_COLUMNS} FROM indexed_items WHERE item_type = ?`
    const params: any[] = [itemType]

    if (module) {
      sql += " AND module = ?"
      params.push(module)
    }

    for (const [key, value] of Object.entries(filters)) {
      const jsonPath = `$.${key}`
      // SQLite's json_extract on a JSON boolean (true/false) returns integer 1/0, not
      // a SQL boolean or string. This matches both TypeScript (JSON.stringify) and Python
      // (json.dumps) stored data, since both serialize booleans as JSON true/false literals
      // which SQLite's JSON functions represent as integers.
      sql += " AND json_extract(attributes, ?) = ?"
      const paramValue = typeof value === "boolean" ? (value ? 1 : 0) : typeof value === "string" ? value : JSON.stringify(value)
      params.push(jsonPath, paramValue)
    }

    sql += " LIMIT ?"
    params.push(limit)

    const rows = this.db.query<RawIndexedItemRow, any[]>(sql).all(...params)
    return rows.map(mapRow)
  }

  searchXmlId(query: string, module?: string, limit = 50): IndexedItem[] {
    return this.search({ query, itemType: "xml_id", module, limit })
  }

  clearModule(module: string): void {
    this.db.run("DELETE FROM indexed_items WHERE module=?", [module])
    this.db.run("DELETE FROM file_metadata WHERE module=?", [module])
  }

  upsertFileMetadata(filePath: string, module: string, fileHash: string): void {
    this.db.run(
      "INSERT INTO file_metadata (file_path, module, file_hash) VALUES (?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET file_hash=excluded.file_hash, last_indexed=CURRENT_TIMESTAMP",
      [filePath, module, fileHash],
    )
  }

  getFileHash(filePath: string): string | null {
    const row = this.db
      .query<{ file_hash: string }, [string]>(
        "SELECT file_hash FROM file_metadata WHERE file_path=?",
      )
      .get(filePath)
    return row?.file_hash ?? null
  }

  indexStatus(): { totalItems: number; totalModules: number; lastIndexed: string | null } {
    const total =
      this.db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM indexed_items").get()?.cnt ??
      0
    const modules =
      this.db
        .query<{ cnt: number }, []>("SELECT COUNT(DISTINCT module) as cnt FROM indexed_items")
        .get()?.cnt ?? 0
    const lastIdx =
      this.db
        .query<{ last_indexed: string }, []>(
          "SELECT MAX(last_indexed) as last_indexed FROM file_metadata",
        )
        .get()?.last_indexed ?? null
    return { totalItems: total, totalModules: modules, lastIndexed: lastIdx }
  }

  withTransaction<T>(fn: () => T): T {
    this.db.run("BEGIN")
    try {
      const result = fn()
      this.db.run("COMMIT")
      return result
    } catch (error) {
      this.db.run("ROLLBACK")
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  beginTransaction(): void {
    this.db.run("BEGIN")
  }

  commitTransaction(): void {
    this.db.run("COMMIT")
  }

  rollbackTransaction(): void {
    this.db.run("ROLLBACK")
  }
}

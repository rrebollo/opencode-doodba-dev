import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Schema is backward compatible with the Python odoo-indexer CLI (aiosqlite version).
// Column names and types are intentionally identical to support existing user databases.

const DEFAULT_SEARCH_LIMIT = 50;

interface RawIndexedItemRow {
  id: number;
  item_type: string;
  name: string;
  parent_name: string | null;
  module: string;
  attributes: string | null;
  dependency_depth: number;
}

interface RawReferenceRow {
  id: number;
  item_id: number;
  file_path: string;
  line_number: number;
  reference_type: string;
  context: string | null;
}

const INDEXED_ITEM_COLUMNS =
  "id, item_type, name, parent_name, module, attributes, dependency_depth";

export interface IndexedItem {
  id: number;
  itemType: string;
  name: string;
  parentName: string | null;
  module: string;
  attributes: Record<string, unknown>;
  dependencyDepth: number;
}

export interface ItemReference {
  id: number;
  itemId: number;
  filePath: string;
  lineNumber: number;
  referenceType: string;
  context: string | null;
}

export interface SearchOptions {
  query?: string;
  itemType?: string;
  parentName?: string;
  module?: string;
  limit?: number;
}

function safeParseAttributes(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    console.warn(`[database] attributes JSON is not an object: ${json.slice(0, 50)}`);
    return {};
  } catch (e) {
    console.warn(
      `[database] malformed attributes JSON (${json.slice(0, 50)}...): ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return {};
  }
}

function mapRow(r: RawIndexedItemRow): IndexedItem {
  return {
    id: r.id,
    itemType: r.item_type,
    name: r.name,
    parentName: r.parent_name,
    module: r.module,
    attributes: safeParseAttributes(r.attributes),
    dependencyDepth: r.dependency_depth,
  };
}

function mapReferenceRow(r: RawReferenceRow): ItemReference {
  return {
    id: r.id,
    itemId: r.item_id,
    filePath: r.file_path,
    lineNumber: r.line_number,
    referenceType: r.reference_type,
    context: r.context,
  };
}

export class DoodbaIndexDatabase {
  private db: Database;
  private stmtUpsertItem: ReturnType<Database["query"]>;
  private stmtUpsertRef: ReturnType<Database["query"]>;
  private stmtUpsertFileMeta: ReturnType<Database["query"]>;
  private stmtGetFileHash: ReturnType<Database["query"]>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.initSchema();

    this.stmtUpsertItem = this.db.query(
      `INSERT INTO indexed_items (item_type, name, parent_name, module, attributes, dependency_depth)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_type, name, parent_name, module) DO UPDATE SET
         attributes=excluded.attributes,
         dependency_depth=excluded.dependency_depth
       RETURNING id`
    );

    this.stmtUpsertRef = this.db.query(
      `INSERT OR IGNORE INTO item_references
       (item_id, file_path, line_number, reference_type, context)
       VALUES (?, ?, ?, ?, ?)`
    );

    this.stmtUpsertFileMeta = this.db.query(
      `INSERT INTO file_metadata (file_path, module, file_hash)
       VALUES (?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         file_hash=excluded.file_hash,
         last_indexed=CURRENT_TIMESTAMP`
    );

    this.stmtGetFileHash = this.db.query(`SELECT file_hash FROM file_metadata WHERE file_path=?`);
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
    `);
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
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS file_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT UNIQUE NOT NULL,
        module TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        last_indexed TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Create FTS5 virtual table for fast full-text search
    this.db.run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS indexed_items_fts 
       USING fts5(name, item_type, module, parent_name, attributes, content=indexed_items, content_rowid=id)`
    );

    // Triggers to keep FTS5 index in sync with indexed_items table
    this.db.run(
      `CREATE TRIGGER IF NOT EXISTS indexed_items_ai AFTER INSERT ON indexed_items BEGIN
         INSERT INTO indexed_items_fts(rowid, name, item_type, module, parent_name, attributes)
         VALUES (new.id, new.name, new.item_type, new.module, new.parent_name, new.attributes);
       END`
    );

    this.db.run(
      `CREATE TRIGGER IF NOT EXISTS indexed_items_ad AFTER DELETE ON indexed_items BEGIN
         DELETE FROM indexed_items_fts WHERE rowid = old.id;
       END`
    );

    this.db.run(
      `CREATE TRIGGER IF NOT EXISTS indexed_items_au AFTER UPDATE ON indexed_items BEGIN
         UPDATE indexed_items_fts SET name=new.name, item_type=new.item_type, module=new.module,
           parent_name=new.parent_name, attributes=new.attributes
         WHERE rowid = new.id;
       END`
    );

    for (const idx of [
      "CREATE INDEX IF NOT EXISTS idx_item_type ON indexed_items(item_type)",
      "CREATE INDEX IF NOT EXISTS idx_item_name ON indexed_items(name)",
      "CREATE INDEX IF NOT EXISTS idx_item_parent ON indexed_items(parent_name)",
      "CREATE INDEX IF NOT EXISTS idx_item_module ON indexed_items(module)",
      "CREATE INDEX IF NOT EXISTS idx_item_type_name ON indexed_items(item_type, name)",
      "CREATE INDEX IF NOT EXISTS idx_dependency_depth ON indexed_items(dependency_depth)",
      "CREATE INDEX IF NOT EXISTS idx_module_item_type ON indexed_items(module, item_type)",
      "CREATE INDEX IF NOT EXISTS idx_ref_item_id ON item_references(item_id)",
      "CREATE INDEX IF NOT EXISTS idx_ref_file ON item_references(file_path)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ref_unique ON item_references(item_id, file_path, line_number, reference_type)",
      "CREATE INDEX IF NOT EXISTS idx_file_path ON file_metadata(file_path)",
      "CREATE INDEX IF NOT EXISTS idx_file_module ON file_metadata(file_path, module)",
    ])
      this.db.run(idx);
  }

  upsertItem(
    itemType: string,
    name: string,
    parentName: string | null,
    module: string,
    attributes: Record<string, unknown>,
    dependencyDepth = 0
  ): number {
    const attrsJson = JSON.stringify(attributes);
    const row = this.stmtUpsertItem.get(
      itemType,
      name,
      parentName,
      module,
      attrsJson,
      dependencyDepth
    ) as { id: number };
    return row.id;
  }

  upsertReference(
    itemId: number,
    filePath: string,
    lineNumber: number,
    referenceType: string,
    context: string | null
  ): void {
    this.stmtUpsertRef.run(itemId, filePath, lineNumber, referenceType, context);
  }

  search(opts: SearchOptions): IndexedItem[] {
    const conditions: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (opts.query) {
      conditions.push("(name LIKE ? OR parent_name LIKE ?)");
      params.push(`%${opts.query}%`, `%${opts.query}%`);
    }
    if (opts.itemType) {
      conditions.push("item_type = ?");
      params.push(opts.itemType);
    }
    if (opts.parentName) {
      conditions.push("parent_name = ?");
      params.push(opts.parentName);
    }
    if (opts.module) {
      conditions.push("module = ?");
      params.push(opts.module);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rawLimit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
    const limit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(Math.floor(rawLimit), 1000))
        : DEFAULT_SEARCH_LIMIT;
    if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit !== limit) {
      console.warn(`[database] LIMIT clamped from ${rawLimit} to ${limit}`);
    }
    const query = `SELECT ${INDEXED_ITEM_COLUMNS} FROM indexed_items ${where} LIMIT ${limit}`;
    const rows = this.db.query<RawIndexedItemRow, SQLQueryBindings[]>(query).all(...params);
    return rows.map(mapRow);
  }

  searchItems(
    query: string,
    options?: { itemType?: string; module?: string; limit?: number }
  ): IndexedItem[] {
    let sql = `
      SELECT DISTINCT ${INDEXED_ITEM_COLUMNS}
      FROM indexed_items i
      WHERE i.id IN (
        SELECT rowid FROM indexed_items_fts WHERE indexed_items_fts MATCH ?
      )
    `;
    const params: SQLQueryBindings[] = [query];

    if (options?.itemType) {
      sql += ` AND i.item_type = ?`;
      params.push(options.itemType);
    }

    if (options?.module) {
      sql += ` AND i.module = ?`;
      params.push(options.module);
    }

    const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
    sql += ` LIMIT ?`;
    params.push(limit);

    const rows = this.db.query<RawIndexedItemRow, SQLQueryBindings[]>(sql).all(...params);
    return rows.map(mapRow);
  }

  getDetails(name: string, itemType: string): IndexedItem | null {
    const row = this.db
      .query<
        RawIndexedItemRow,
        SQLQueryBindings[]
      >(`SELECT ${INDEXED_ITEM_COLUMNS} FROM indexed_items WHERE name=? AND item_type=? LIMIT 1`)
      .get(name, itemType);
    if (!row) return null;
    return mapRow(row);
  }

  listModules(): string[] {
    return this.db
      .query<{ module: string }, []>("SELECT DISTINCT module FROM indexed_items ORDER BY module")
      .all()
      .map((r) => r.module);
  }

  moduleStats(module: string): Record<string, number> {
    const rows = this.db
      .query<
        { item_type: string; cnt: number },
        [string]
      >("SELECT item_type, COUNT(*) as cnt FROM indexed_items WHERE module=? GROUP BY item_type")
      .all(module);
    return Object.fromEntries(rows.map((r) => [r.item_type, r.cnt]));
  }

  findRefs(name: string, itemType: string): ItemReference[] {
    const rows = this.db
      .query<
        RawReferenceRow,
        SQLQueryBindings[]
      >("SELECT r.id, r.item_id, r.file_path, r.line_number, r.reference_type, r.context FROM item_references r JOIN indexed_items i ON r.item_id=i.id WHERE i.name=? AND i.item_type=?")
      .all(name, itemType);
    return rows.map(mapReferenceRow);
  }

  searchByAttr(
    itemType: string,
    filters: Record<string, unknown>,
    module?: string,
    limit = 50
  ): IndexedItem[] {
    let sql = `SELECT ${INDEXED_ITEM_COLUMNS} FROM indexed_items WHERE item_type = ?`;
    const params: SQLQueryBindings[] = [itemType];

    if (module) {
      sql += " AND module = ?";
      params.push(module);
    }

    for (const [key, value] of Object.entries(filters)) {
      const jsonPath = `$.${key}`;
      // SQLite's json_extract on a JSON boolean (true/false) returns integer 1/0, not
      // a SQL boolean or string. This matches both TypeScript (JSON.stringify) and Python
      // (json.dumps) stored data, since both serialize booleans as JSON true/false literals
      // which SQLite's JSON functions represent as integers.
      sql += " AND json_extract(attributes, ?) = ?";
      const paramValue =
        typeof value === "boolean"
          ? value
            ? 1
            : 0
          : typeof value === "string"
            ? value
            : JSON.stringify(value);
      params.push(jsonPath, paramValue);
    }

    sql += " LIMIT ?";
    params.push(limit);

    const rows = this.db.query<RawIndexedItemRow, SQLQueryBindings[]>(sql).all(...params);
    return rows.map(mapRow);
  }

  searchXmlId(query: string, module?: string, limit = 50): IndexedItem[] {
    return this.search({ query, itemType: "xml_id", module, limit });
  }

  clearModule(module: string): void {
    this.db.run("DELETE FROM indexed_items WHERE module=?", [module]);
    this.db.run("DELETE FROM file_metadata WHERE module=?", [module]);
  }

  upsertFileMetadata(filePath: string, module: string, fileHash: string): void {
    this.stmtUpsertFileMeta.run(filePath, module, fileHash);
  }

  getFileHash(filePath: string): string | null {
    const row = this.stmtGetFileHash.get(filePath) as { file_hash: string } | undefined;
    return row?.file_hash ?? null;
  }

  getAllFileHashes(): Map<string, string> {
    const rows = this.db
      .query<
        { file_path: string; file_hash: string },
        []
      >("SELECT file_path, file_hash FROM file_metadata")
      .all();
    const hashes = new Map<string, string>();
    for (const row of rows) {
      hashes.set(row.file_path, row.file_hash);
    }
    return hashes;
  }

  indexStatus(): { totalItems: number; totalModules: number; lastIndexed: string | null } {
    const total =
      this.db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM indexed_items").get()?.cnt ??
      0;
    const modules =
      this.db
        .query<{ cnt: number }, []>("SELECT COUNT(DISTINCT module) as cnt FROM indexed_items")
        .get()?.cnt ?? 0;
    const lastIdx =
      this.db
        .query<
          { last_indexed: string },
          []
        >("SELECT MAX(last_indexed) as last_indexed FROM file_metadata")
        .get()?.last_indexed ?? null;
    return { totalItems: total, totalModules: modules, lastIndexed: lastIdx };
  }

  close(): void {
    this.db.close();
  }

  beginTransaction(): void {
    this.db.run("BEGIN");
  }

  commitTransaction(): void {
    this.db.run("COMMIT");
  }

  rollbackTransaction(): void {
    this.db.run("ROLLBACK");
  }
}

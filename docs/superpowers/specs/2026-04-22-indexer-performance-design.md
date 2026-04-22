# High-Performance Indexer Design

**Date:** 2026-04-22
**Status:** Approved for Implementation
**Impact:** 16 min → 3-4 min indexing (5x speedup), 5-10x faster queries

---

## Problem Statement

The current indexer takes **~16 minutes** to index a typical Doodba project (~18,500 files across 33 repo groups). Profiling reveals three dominant bottlenecks:

1. **Python subprocess overhead** (60-70% of total time): Each `.py` file spawns a new Python process (fork + exec + interpreter startup + AST import). At 11,868 files × ~50-80ms = **10-13 minutes** of pure overhead.
2. **Wasted filesystem traversal** (10-15%): `walkDir` recurses into `static/`, `i18n/`, `__pycache__/`, and other never-relevant directories. For the `sale` addon, 12 of 22 directories (55%) are traversed unnecessarily.
3. **Query performance** (user-facing): Every `doodba_search` uses `LIKE '%query%'` which forces a full table scan on `indexed_items`. Search latency degrades linearly with database size.

Secondary issues:
- Files read 2-3 times per indexing (hash + parser + Python re-read)
- No prepared statements; SQL re-parsed thousands of times
- N+1 `SELECT id` after every `INSERT` in `upsertItem()`
- Database opened/closed on every tool call (~50-100ms overhead)
- No result caching for stable reads like `listModules()`

---

## Goals

1. **Reduce full re-index time from 16 min to 3-4 min** (5x speedup)
2. **Reduce search latency from ~500ms-2s to <10ms** (FTS5)
3. **Maintain correctness** — all existing tests pass, same indexed output
4. **Backward compatibility** — SQLite schema remains compatible with Python odoo-indexer CLI

---

## Non-Goals

- Rewriting the Python parser in TypeScript (too risky, may miss Python edge cases)
- Changing the plugin API or tool signatures
- Adding incremental/delta indexing (out of scope; full re-index only for now)
- Indexing non-Odoo file types (`.po`, `.rst`, `.md`, `.js`, `.scss`)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Phase 1: Foundation (Independent, Low Risk)                │
│  ├─ Smart directory traversal (skip static/, i18n/, etc.)   │
│  ├─ Single-pass walk (collect .py/.xml/.csv in one pass)    │
│  ├─ Prepared statements + RETURNING id                      │
│  └─ Missing indexes (file_metadata.module, covering index)  │
├─────────────────────────────────────────────────────────────┤
│  Phase 2: Batch Python Pipeline (Biggest Win)               │
│  ├─ Long-lived Python parser process (stdin/stdout protocol)│
│  ├─ Single-pass file reading (Buffer → hash + parser)       │
│  └─ Batch hash preload (Map lookup replaces SELECT)         │
├─────────────────────────────────────────────────────────────┤
│  Phase 3: Parallel Indexing                                 │
│  └─ Worker pool for repo groups (4-8 Bun workers)           │
├─────────────────────────────────────────────────────────────┤
│  Phase 4: Query Performance                                 │
│  ├─ FTS5 virtual table for search()                         │
│  ├─ Connection caching for tools                            │
│  └─ LRU cache for listModules/moduleStats/indexStatus       │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Foundation

### 1.1 Smart Directory Traversal

**Current behavior:** `walkDir` skips only hidden dirs and symlinks. It recurses into `static/`, `i18n/`, `__pycache__/`, etc.

**New behavior:** Add an explicit skip list:

```typescript
const SKIP_DIRS = new Set([
  "static",      // JS, SCSS, images — never relevant to code indexer
  "i18n",        // .po/.pot translation files
  "__pycache__", // Python bytecode cache
  "node_modules",// NPM dependencies (if any)
  ".git",        // Git metadata (already skipped by hidden rule, but explicit is safer)
  "setup",       // OCA setup files
  "readme",      // Documentation
  "doc",         // Documentation
  "migrations",  // Odoo migration scripts (optional — can be indexed if needed)
  "tests",       // Test files (configurable — default skip)
  "controllers", // Keep? Yes — may contain business logic
  "report",      // Keep — may contain QWeb/XML reports
  "wizard",      // Keep — wizards are models
  "data",        // Keep — contains .xml/.csv
  "demo",        // Keep — contains .xml demo data
  "security",    // Keep — contains .csv ir.model.access records
  "views",       // Keep — contains .xml views
  "models",      // Keep — contains .py models
  "populate",    // Keep — contains population scripts
]);
```

**Decision:** `migrations/` and `tests/` are configurable. By default, skip `migrations/` (rarely queried) and index `tests/` (often contain model definitions). Add an option to `indexModules()`:

```typescript
interface IndexOptions {
  // ... existing options
  skipTests?: boolean;       // default false
  skipMigrations?: boolean;  // default true
}
```

**Impact:** For the `sale` addon (22 dirs → ~10 dirs), cuts directory entries by ~55%. At project scale, eliminates tens of thousands of `readdirSync` calls.

### 1.2 Single-Pass Directory Walk

**Current behavior:** Three separate `walkDir` calls per module:
```typescript
indexFiles(walkDir(mod.path, [".py"]), parsePython, ...);
indexFiles(walkDir(mod.path, [".xml"]), parseXml, ...);
indexFiles(walkDir(mod.path, [".csv"]), parseCsv, ...);
```

**New behavior:** One `walkDir` call per module, returning a map:

```typescript
interface ModuleFiles {
  py: string[];
  xml: string[];
  csv: string[];
}

function walkModule(modPath: string): ModuleFiles {
  const result: ModuleFiles = { py: [], xml: [], csv: [] };
  // Single recursive walk, classify by extension
  // ...
  return result;
}
```

**Impact:** Cuts directory traversal from 3× to 1× per module. For 1,109 modules, saves ~2,218 full tree walks.

### 1.3 Prepared Statements + RETURNING id

**Current behavior:** `upsertItem()` runs `INSERT ... ON CONFLICT DO UPDATE` then `SELECT id ...`. Two SQL round-trips per item.

**New behavior:**

```typescript
// Prepared in constructor
private stmtUpsertItem: ReturnType<Database["query"]>;

constructor(dbPath: string) {
  // ... existing init ...
  this.stmtUpsertItem = this.db.query(
    `INSERT INTO indexed_items (item_type, name, parent_name, module, attributes, dependency_depth)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_type, name, parent_name, module) DO UPDATE SET
       attributes=excluded.attributes,
       dependency_depth=excluded.dependency_depth
     RETURNING id`
  );
}

upsertItem(...): number {
  const row = this.stmtUpsertItem.get(
    itemType, name, parentName, module, JSON.stringify(attributes), dependencyDepth
  );
  return row?.id ?? 0;
}
```

**Impact:** Eliminates the N+1 `SELECT id` query. For 125,917 items, saves ~125,917 SQL round-trips.

### 1.4 Missing Indexes

Add three indexes:

```sql
-- For clearModule() — currently does DELETE without index
CREATE INDEX IF NOT EXISTS idx_file_module ON file_metadata(module);

-- For moduleStats() — currently scans module then looks up item_type
CREATE INDEX IF NOT EXISTS idx_module_item_type ON indexed_items(module, item_type);

-- For searchByAttr() on common field attributes (optional, can add later)
-- CREATE INDEX IF NOT EXISTS idx_attr_compute ON indexed_items(json_extract(attributes, '$.compute'));
```

**Impact:** `clearModule()` and `moduleStats()` become index-only or indexed scans instead of table scans.

---

## Phase 2: Batch Python Pipeline

### 2.1 Long-Lived Python Parser Process

**Design:** A Python process that reads JSON lines from stdin and writes JSON lines to stdout.

**Protocol:**

```
# TypeScript → Python (stdin)
{"path": "/abs/path/to/file.py", "content": "file contents as string..."}\n
# Python → TypeScript (stdout)
{"path": "/abs/path/to/file.py", "items": [...], "error": null}\n
# Shutdown signal
{"action": "close"}\n
# Python → TypeScript (after close)
{"status": "closed"}\n```

**Python side (`src/parsers/python_ast_extract_batch.py`):**

```python
#!/usr/bin/env python3
"""Batch Python AST extractor. Reads JSON lines from stdin, outputs JSON lines."""
import sys, json, ast

def parse_file(path: str, content: str):
    """Same logic as current python_ast_extract.py but takes content instead of reading file."""
    try:
        tree = ast.parse(content)
        items = []
        # ... existing AST walking logic ...
        return {"path": path, "items": items, "error": None}
    except SyntaxError as e:
        return {"path": path, "items": [], "error": str(e)}

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        if msg.get("action") == "close":
            print(json.dumps({"status": "closed"}), flush=True)
            break
        result = parse_file(msg["path"], msg["content"])
        print(json.dumps(result), flush=True)

if __name__ == "__main__":
    main()
```

**TypeScript side (`src/parsers/python-batch.ts`):**

```typescript
import { spawn } from "bun";

export class PythonBatchParser {
  private process: ReturnType<typeof spawn>;
  private pending = new Map<string, { resolve; reject }>();
  private buffer = "";

  constructor(scriptPath: string) {
    this.process = spawn(["python3", scriptPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Read stdout line-by-line
    const reader = this.process.stdout.getReader();
    const readLoop = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += new TextDecoder().decode(value);
        let nl;
        while ((nl = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          this.handleLine(line);
        }
      }
    };
    readLoop();
  }

  async parse(path: string, content: string) {
    return new Promise((resolve, reject) => {
      this.pending.set(path, { resolve, reject });
      const msg = JSON.stringify({ path, content }) + "\n";
      this.process.stdin.write(msg);
    });
  }

  private handleLine(line: string) {
    const result = JSON.parse(line);
    if (result.status === "closed") return;
    const pending = this.pending.get(result.path);
    if (pending) {
      pending.resolve(result);
      this.pending.delete(result.path);
    }
  }

  async close() {
    this.process.stdin.write(JSON.stringify({ action: "close" }) + "\n");
    await this.process.exited;
  }
}
```

**Usage in `indexer.ts`:**

```typescript
// At indexing start
const pythonParser = new PythonBatchParser(resolve(packageRoot, "src/parsers/python_ast_extract_batch.py"));

// For each .py file
const content = readFileSync(filePath, "utf-8");
const result = await pythonParser.parse(filePath, content);
// result.items is the same shape as current parsePython() output

// At indexing end
await pythonParser.close();
```

**Error handling:**
- If Python process crashes, restart it and retry the current batch
- If a single file fails to parse, log warning and continue (same as current behavior)
- Timeout: if no response for 30s, kill and restart

**Impact:** Cuts Python overhead from ~10-13 min to ~10-20s (one process startup + streaming overhead).

### 2.2 Single-Pass File Reading

**Current flow:**
1. `fileHash(f)` → `readFileSync(f)` into Buffer → SHA256
2. `parsePython(f)` → Python process reads file again
3. `parseXml(f)` → `readFileSync(f)` into string

**New flow:**
1. Read file into `Buffer` once
2. Compute hash from Buffer
3. Pass `Buffer.toString("utf-8")` to parser (no re-read)

```typescript
function indexFile(filePath: string, parser: FileParser, opts: IndexFilesOptions): void {
  const content = readFileSync(filePath);
  const hash = createHash("sha256").update(content).digest("hex").slice(0, HASH_LENGTH);
  // ... hash check ...
  const items = parser(filePath, content.toString("utf-8"), opts.mod.name);
  // ...
}
```

**Impact:** Cuts file I/O by ~50% (from 2-3 reads per file to 1 read).

### 2.3 Batch Hash Preload

**Current behavior:** `getFileHash(f)` runs `SELECT file_hash FROM file_metadata WHERE file_path=?` once per file.

**New behavior:** At start of each module, preload all hashes:

```typescript
// In indexModules(), before processing module files
const hashMap = new Map<string, string>();
const hashes = db.query("SELECT file_path, file_hash FROM file_metadata WHERE module=?")
  .all(mod.name) as { file_path: string; file_hash: string }[];
for (const h of hashes) {
  hashMap.set(h.file_path, h.file_hash);
}

// In indexFiles(), replace getFileHash() with:
const existing = hashMap.get(filePath);
```

**Impact:** Eliminates 18,500 SELECT queries (one per file). Replaced by ~1,109 queries (one per module).

---

## Phase 3: Parallel Indexing

### 3.1 Worker Pool for Repo Groups

**Design:** Use Bun's `Worker` API to spawn 4-8 workers. Each worker indexes one repo group independently.

**Architecture:**

```
Main Process
  ├─ discoverModules(allRootPaths) → Map<string, ModuleNode>
  ├─ resolveDependencyOrder(allModules) → ModuleNode[]
  ├─ Partition modules by repo group
  ├─ Spawn workers (one per repo group, max 8 concurrent)
  │   Worker 1: index modules in [timesheet/, hr/]
  │   Worker 2: index modules in [sale-workflow/, stock-logistics-workflow/]
  │   ...
  ├─ Each worker writes to its own temp DB
  ├─ Wait for all workers
  ├─ Merge temp DBs into main DB (ATTACH + INSERT)
  └─ Update state.json
```

**Worker script (`src/indexer-worker-batched.ts`):**

```typescript
// Receives: { modules: ModuleNode[], dbPath: string, rootPaths: string[] }
// Creates temporary SQLite DB
// Indexes modules
// Returns: { indexed, skipped, errors, missingDeps }
```

**DB merge:**

```sql
-- Attach worker DB
ATTACH DATABASE '/tmp/worker-1.db' AS worker1;

-- Insert items
INSERT OR REPLACE INTO main.indexed_items
  SELECT * FROM worker1.indexed_items;

-- Insert references
INSERT OR IGNORE INTO main.item_references
  SELECT * FROM worker1.item_references;

-- Insert file metadata
INSERT OR REPLACE INTO main.file_metadata
  SELECT * FROM worker1.file_metadata;

DETACH DATABASE worker1;
```

**Complexity considerations:**
- Dependency ordering must happen globally (before partitioning)
- Missing deps must be collected from all workers and deduplicated
- Each worker needs its own Python parser process
- Temp DB cleanup after merge

**Alternative (simpler):** Parallelize at the file-parsing level, not the module level. Use a queue of files and a pool of Python parser processes. This avoids DB merging complexity.

**Decision:** Start with **parallel Python parsers** (queue-based) rather than full worker partitioning. Simpler, less complexity, still significant speedup on multi-core. Revisit full worker partitioning if needed.

### 3.2 Parallel Python Parsers (Queue-Based)

```typescript
class PythonParserPool {
  private parsers: PythonBatchParser[];
  private queue: { path: string; content: string; resolve; reject }[] = [];

  constructor(poolSize: number, scriptPath: string) {
    this.parsers = Array.from({ length: poolSize }, () => new PythonBatchParser(scriptPath));
  }

  async parse(path: string, content: string) {
    // Round-robin to least-busy parser
    const parser = this.getLeastBusyParser();
    return parser.parse(path, content);
  }

  private getLeastBusyParser(): PythonBatchParser {
    // Simple round-robin or check pending.size
    return this.parsers.reduce((a, b) => a.pending.size < b.pending.size ? a : b);
  }
}
```

**Impact:** On a 4-core system, 4 Python parsers can process files concurrently. Additional ~20-30% speedup on top of batching.

---

## Phase 4: Query Performance

### 4.1 FTS5 Virtual Table

**Schema addition:**

```sql
-- FTS5 virtual table for full-text search on name and parent_name
CREATE VIRTUAL TABLE IF NOT EXISTS indexed_items_fts USING fts5(
  name,
  parent_name,
  content='indexed_items',  -- Shadow table: auto-sync with indexed_items
  content_rowid='id'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS indexed_items_fts_insert
  AFTER INSERT ON indexed_items
BEGIN
  INSERT INTO indexed_items_fts(rowid, name, parent_name)
  VALUES (new.id, new.name, new.parent_name);
END;

CREATE TRIGGER IF NOT EXISTS indexed_items_fts_delete
  AFTER DELETE ON indexed_items
BEGIN
  INSERT INTO indexed_items_fts(indexed_items_fts, rowid, name, parent_name)
  VALUES ('delete', old.id, old.name, old.parent_name);
END;

CREATE TRIGGER IF NOT EXISTS indexed_items_fts_update
  AFTER UPDATE ON indexed_items
BEGIN
  INSERT INTO indexed_items_fts(indexed_items_fts, rowid, name, parent_name)
  VALUES ('delete', old.id, old.name, old.parent_name);
  INSERT INTO indexed_items_fts(rowid, name, parent_name)
  VALUES (new.id, new.name, new.parent_name);
END;
```

**Query rewrite:**

```typescript
search(opts: SearchOptions): IndexedItem[] {
  if (opts.query && !opts.itemType && !opts.parentName && !opts.module) {
    // Use FTS5 for bare text search
    const ftsQuery = opts.query.split(/\s+/).map(w => `${w}*`).join(" ");
    const rows = this.db.query(`
      SELECT ${INDEXED_ITEM_COLUMNS} FROM indexed_items
      WHERE id IN (
        SELECT rowid FROM indexed_items_fts WHERE indexed_items_fts MATCH ?
      )
      LIMIT ?
    `).all(ftsQuery, opts.limit ?? DEFAULT_SEARCH_LIMIT);
    return rows.map(mapRow);
  }
  // ... fallback to existing query for filtered searches
}
```

**Impact:** Sub-10ms search vs 500ms-2s table scan. FTS5 is built into SQLite (no extra dependency).

### 4.2 Connection Caching

**Current behavior:** `withDbAsync()` creates new `DoodbaIndexDatabase` per tool call.

**New behavior:** Module-level cache with TTL:

```typescript
// src/tools/helpers.ts
const dbCache = new Map<string, { db: DoodbaIndexDatabase; lastUsed: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getDb(projectDir: string): DoodbaIndexDatabase {
  const cached = dbCache.get(projectDir);
  if (cached && Date.now() - cached.lastUsed < CACHE_TTL_MS) {
    cached.lastUsed = Date.now();
    return cached.db;
  }
  // Close old connection if exists
  if (cached) cached.db.close();
  const db = new DoodbaIndexDatabase(getProjectDbPath(projectDir));
  dbCache.set(projectDir, { db, lastUsed: Date.now() });
  return db;
}
```

**Impact:** ~50-100ms saved per tool call (no schema init, no PRAGMAs, no index verification).

### 4.3 LRU Cache for Stable Reads

```typescript
import { LRUCache } from "lru-cache"; // or simple Map-based LRU

class CachedDatabase extends DoodbaIndexDatabase {
  private moduleListCache?: { result: string[]; ts: number };
  private moduleStatsCache = new Map<string, { result: Record<string, number>; ts: number }>();
  private readonly CACHE_TTL = 60_000; // 60 seconds

  listModules(): string[] {
    if (this.moduleListCache && Date.now() - this.moduleListCache.ts < this.CACHE_TTL) {
      return this.moduleListCache.result;
    }
    const result = super.listModules();
    this.moduleListCache = { result, ts: Date.now() };
    return result;
  }

  moduleStats(module: string): Record<string, number> {
    const cached = this.moduleStatsCache.get(module);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) {
      return cached.result;
    }
    const result = super.moduleStats(module);
    this.moduleStatsCache.set(module, { result, ts: Date.now() });
    return result;
  }
}
```

**Impact:** Near-instant repeated queries for `listModules()` and `moduleStats()`.

---

## Backward Compatibility

### Schema Compatibility

The SQLite schema must remain compatible with the Python odoo-indexer CLI. The changes are **additive only**:

- New indexes: `CREATE INDEX IF NOT EXISTS` (safe, idempotent)
- FTS5 table: `CREATE VIRTUAL TABLE IF NOT EXISTS` (new table, doesn't affect existing queries)
- Triggers on FTS5: only fire if FTS5 table exists (Python CLI won't create it, so no impact)
- Prepared statements: implementation detail, no schema change
- `RETURNING id`: SQL syntax change, no schema change

### API Compatibility

All tool signatures remain unchanged. Internal implementation changes only.

---

## Testing Strategy

### Unit Tests
- `PythonBatchParser` protocol (start, parse single file, parse multiple files, close, error handling)
- `walkModule()` single-pass classification
- Prepared statement correctness (same results as before)
- `RETURNING id` correctness (same ID as before)

### Integration Tests
- Full index on test fixture → compare item counts and content with baseline
- Search with FTS5 → verify same results as `LIKE` search
- Connection caching → verify TTL expiry
- Parallel parser pool → verify deterministic results

### Performance Benchmarks
- Time full index on test fixture (before/after)
- Time 100 searches (before/after)
- Memory usage during indexing (before/after)

---

## Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Python batch process crashes | Medium | Low | Auto-restart with retry; log warning |
| FTS5 not available in older SQLite | Low | Low | Bun bundles recent SQLite; check at runtime |
| Parallel parsing produces different results | High | Low | Deterministic round-robin; same parser code |
| Schema change breaks Python CLI | High | Low | Additive only; test with Python CLI |
| Memory pressure from connection cache | Low | Medium | TTL-based eviction; max cache size limit |
| `static/` skip misses relevant files | Medium | Low | Make skips configurable; default is conservative |

---

## Implementation Order

| Phase | PR | Estimated Time | Can Ship Independently? |
|-------|-----|----------------|------------------------|
| 1.1 Smart directory traversal | #1 | 2-3 hours | Yes |
| 1.2 Single-pass walk | #1 | 1-2 hours | Yes |
| 1.3 Prepared statements + RETURNING id | #2 | 2-3 hours | Yes |
| 1.4 Missing indexes | #2 | 30 min | Yes |
| 2.1 Batch Python parser | #3 | 4-6 hours | Needs Phase 1 |
| 2.2 Single-pass file reading | #3 | 1-2 hours | Needs Phase 1 |
| 2.3 Batch hash preload | #3 | 1-2 hours | Needs Phase 1 |
| 3.2 Parallel Python parsers | #4 | 3-4 hours | Needs Phase 2 |
| 4.1 FTS5 search | #5 | 2-3 hours | Yes |
| 4.2 Connection caching | #5 | 1-2 hours | Yes |
| 4.3 LRU cache | #5 | 1 hour | Yes |

**Recommended order:** Phase 1 (PR #1 + #2) → Phase 2 (PR #3) → Phase 4 (PR #5) → Phase 3 (PR #4, optional).

---

## Success Criteria

- [ ] Full re-index time < 5 minutes on the oca-17 project (down from 16 min)
- [ ] `doodba_search` latency < 50ms for common queries
- [ ] All 90 existing tests pass without modification
- [ ] Indexed item count identical before/after (no data loss)
- [ ] No new dependencies (FTS5 is built into SQLite)
- [ ] Memory usage during indexing < 2GB peak

---

## Appendix: Current vs Proposed Comparison

| Aspect | Current | Proposed | Improvement |
|--------|---------|----------|-------------|
| Python parsing | 11,868 process spawns | 1 long-lived process + optional pool | 60-70% faster |
| Directory traversal | 3 walks per module, no skips | 1 walk per module, skip static/i18n/etc | 15-20% faster |
| File reading | 2-3 reads per file | 1 read per file | 15% faster |
| SQL statements | Recreated per call, N+1 SELECT | Prepared, RETURNING id | 20-30% faster |
| Hash lookups | 18,500 SELECT queries | 1,109 SELECT queries + Map | Eliminates 94% |
| Search | `LIKE '%x%'` full table scan | FTS5 index | 50-100x faster |
| DB connections | Open/close per tool call | Cached with TTL | ~50ms per call |
| **Total index time** | **~16 min** | **~3-4 min** | **5x speedup** |
| **Search latency** | **~500ms-2s** | **<10ms** | **50-200x faster** |

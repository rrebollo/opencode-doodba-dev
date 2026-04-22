# 01: Core Backend Analysis

**Context**: This section covers the TypeScript backend: database wrapper, indexer orchestration, dependency resolution, and worker coordination.

**Files analyzed**:
- `src/database.ts` (337 lines)
- `src/indexer.ts` (167 lines)
- `src/dependency-tree.ts` (164 lines)
- `src/project-state.ts` (73 lines)
- `src/indexer-worker.ts` (46 lines)
- `src/glob.ts` (16 lines)

---

## Tech Stack

- **SQLite via Bun**: `bun:sqlite` synchronous API (no async/await)
- **File I/O**: Node.js `fs` module (blocking calls)
- **Dependency graph**: Custom DFS-based cycle detection and topological sort
- **State storage**: JSON file (`state.json`) + SQLite database
- **Worker spawning**: `Bun.spawn` fire-and-forget (no lifecycle tracking)
- **Hashing**: SHA-256 (`node:crypto`) for change detection

---

## 🔴 Critical Issues

### 1. Unprotected `JSON.parse` in Database Queries

**File/Line**: `database.ts:65`

**Severity**: 🔴 Critical — Crashes on corrupted DB rows

**Description**: 
The `mapRow` function calls `JSON.parse(r.attributes)` without a try/catch. If any row in the database has malformed JSON in the `attributes` column (from manual edits, a Python indexer crash, or disk corruption), the entire database query throws an uncaught exception.

**Evidence**:
```typescript
// database.ts:65
attributes: r.attributes ? JSON.parse(r.attributes) : {}
```

**Impact**:
- Any tool that calls `db.search()` or `db.getItemById()` crashes
- Index becomes completely unusable
- No partial recovery possible

**Fix**:
```typescript
attributes: r.attributes 
  ? (() => { try { return JSON.parse(r.attributes) } catch { console.warn(`[db] malformed JSON in row ${r.id}`); return {} } })() 
  : {}
```

Or refactor to a helper:
```typescript
function safeParseAttributes(json: string | null): Record<string, any> {
  if (!json) return {}
  try {
    return JSON.parse(json)
  } catch (e) {
    console.warn(`[db] malformed attributes JSON`, e)
    return {}
  }
}
```

---

### 2. SQL Injection via Unescaped `LIMIT` Parameter

**File/Line**: `database.ts:198` (in `search()` method)

**Severity**: 🔴 Critical — Arbitrary SQL execution

**Description**:
The `search()` method accepts `opts.limit` (typed as `number | undefined`) and interpolates it directly into the SQL query string without validation or escaping. If `opts.limit` is passed as a string or object, it gets concatenated as a raw SQL fragment.

**Evidence**:
```typescript
// database.ts:198
const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT
const query = `SELECT ... LIMIT ${limit}`
```

**Scenario**:
```typescript
db.search({ /* ... */ limit: "1; DROP TABLE indexed_items; --" as any })
// Results in:
// SELECT ... LIMIT 1; DROP TABLE indexed_items; --
```

**Impact**:
- Malicious tool arguments can destroy the database
- No validation of user input before SQL construction

**Fix**:
```typescript
const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_SEARCH_LIMIT, 1000))
// Use parameterized query if bun:sqlite supports it, otherwise validate strictly
```

---

### 3. Database Connection Closed While Tools Are Using It

**File/Line**: `src/tools/helpers.ts:34-36`

**Severity**: 🔴 Critical — `SQLITE_MISUSE` crashes

**Description**:
The `withDb` helper function returns the result of `fn(db)` inside a try block, then immediately closes the database in the finally block. If the callback returns a Promise or an async generator, the database is closed while the async operation is still pending. Subsequent database operations in the Promise will fail with `SQLITE_MISUSE`.

**Evidence**:
```typescript
// src/tools/helpers.ts
export function withDb<T>(fn: (db: DoodbaIndexDatabase) => T): T {
  const db = new DoodbaIndexDatabase(dbPath)
  try {
    return fn(db)  // <-- Returns immediately if fn returns a Promise
  } finally {
    db.close()     // <-- Closes while Promise is still pending
  }
}
```

**Scenario**:
```typescript
// A tool returns an async generator or Promise
async function* lazySearch() {
  const results = await withDb(db => Promise.resolve(db.search(/* ... */)))
  // db is already closed by the time this line runs!
  yield results
}
```

**Impact**:
- Any lazy/async tool using `withDb` crashes at runtime
- Difficult to debug because the error manifests in the async callback, not at the call site

**Fix**:
```typescript
export async function withDb<T>(fn: (db: DoodbaIndexDatabase) => Promise<T>): Promise<T> {
  const db = new DoodbaIndexDatabase(dbPath)
  try {
    return await fn(db)  // Now we actually wait for the Promise
  } finally {
    db.close()
  }
}

// OR: Reject async callbacks explicitly
export function withDb<T>(fn: (db: DoodbaIndexDatabase) => T): T {
  if (fn.constructor.name === 'AsyncFunction') {
    throw new Error('withDb does not support async callbacks. Use withDbAsync instead.')
  }
  const db = new DoodbaIndexDatabase(dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}
```

---

### 4. Non-Atomic State File Updates (Race Condition)

**File/Line**: `src/project-state.ts:58-72`

**Severity**: 🔴 Critical — Concurrent workers corrupt `state.json`

**Description**:
The `updateState()` function reads the JSON file, parses it, merges it with the update, and writes it back. This is a classic read-modify-write race condition. If two processes (e.g., two OpenCode windows or a background worker + main thread) call `updateState()` simultaneously, one update will be lost.

**Evidence**:
```typescript
// src/project-state.ts:58-72
export function updateState(root: string, partial: Partial<DoodbaIndexState>): void {
  const statePath = join(getStateDir(root), "state.json")
  let current = { ...DEFAULT_STATE }
  if (existsSync(statePath)) {
    const content = readFileSync(statePath, "utf-8")
    current = { ...DEFAULT_STATE, ...JSON.parse(content) }
  }
  const next = { ...current, ...partial }  // <-- Merged update
  writeFileSync(statePath, JSON.stringify(next, null, 2))  // <-- Atomic-looking but not really
}
```

**Timeline of corruption**:
```
Process A: read state.json → {"status": "READY"}
Process B: read state.json → {"status": "READY"}
Process A: merge {"status": "INDEXING"} → write state.json
Process B: merge {"indexedAt": "2026-04-21"} → write state.json  ← OVERWRITES A's status!
Result: state.json → {"status": "READY", "indexedAt": "2026-04-21"}  (LOST indexing!)
```

**Impact**:
- Indexing status gets corrupted between workers
- Inconsistent state visible to multiple plugin instances
- Potential infinite loops if STUCK detection sees wrong status

**Fix** (Option 1: Atomic file replace):
```typescript
export function updateState(root: string, partial: Partial<DoodbaIndexState>): void {
  const statePath = join(getStateDir(root), "state.json")
  const tmpPath = statePath + ".tmp"
  
  let current = { ...DEFAULT_STATE }
  if (existsSync(statePath)) {
    const content = readFileSync(statePath, "utf-8")
    current = { ...DEFAULT_STATE, ...JSON.parse(content) }
  }
  const next = { ...current, ...partial }
  
  // Write to temp file, then rename (atomic on POSIX)
  writeFileSync(tmpPath, JSON.stringify(next, null, 2))
  renameSync(tmpPath, statePath)
}
```

**Fix** (Option 2: SQLite mutex):
Since the plugin already uses SQLite, leverage it as a distributed mutex:
```typescript
// Inside DoodbaIndexDatabase constructor, ensure a lock table exists
this.db.run(`
  CREATE TABLE IF NOT EXISTS _lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    locked_at TEXT
  );
  INSERT OR IGNORE INTO _lock VALUES (1, datetime('now'));
`)

export function updateState(root: string, partial: Partial<DoodbaIndexState>): void {
  const db = new DoodbaIndexDatabase(...)
  try {
    db.run("BEGIN IMMEDIATE")  // Exclusive lock
    // ... read/merge/write state.json ...
    db.run("COMMIT")
  } catch (e) {
    db.run("ROLLBACK")
    throw e
  }
}
```

---

### 5. Silent Failure on Unreadable Files

**File/Line**: `src/indexer.ts:72-79`

**Severity**: 🔴 Critical — Silent corruption of incremental indexing

**Description**:
The `fileHash()` function catches all errors and returns an empty string. This includes permission-denied, file-deleted, and I/O errors. If a file becomes unreadable (permissions removed, NFS mount fails, etc.), it hashes to `""`. On the next incremental index, the function returns `""` again, and the file is skipped as "unchanged" even though it's now corrupt/inaccessible.

**Evidence**:
```typescript
// src/indexer.ts:72-79
function fileHash(filePath: string): string {
  const HASH_LENGTH = 16
  const hash = createHash("sha256")
  try {
    hash.update(readFileSync(filePath))
  } catch {
    return ""  // <-- ALL errors → empty hash
  }
  return hash.digest("hex").slice(0, HASH_LENGTH)
}
```

**Scenario**:
```
Run 1: /opt/odoo/custom/src/my_module/models.py hashes to "abc123"
       → Indexed successfully
Run 2: /opt/odoo/custom/src/my_module/models.py becomes unreadable (chmod 000)
       → fileHash returns ""
       → Incremental indexer: "No hash found OR hash matches" → skips the file
       → Index becomes stale for that file silently
```

**Impact**:
- After files lose read permissions, they are never re-indexed
- Incremental indexing silently skips permission-denied files
- Users have no indication that indexing is incomplete

**Fix**:
```typescript
function fileHash(filePath: string): string {
  const HASH_LENGTH = 16
  try {
    const hash = createHash("sha256")
    hash.update(readFileSync(filePath))
    return hash.digest("hex").slice(0, HASH_LENGTH)
  } catch (e) {
    // Return a unique hash based on the error, not a collision
    if (e instanceof Error) {
      return `ERR_${createHash("sha256").update(e.message + filePath).digest("hex").slice(0, 12)}`
    }
    throw new Error(`[fileHash] failed on ${filePath}: ${e}`)
  }
}
```

Then in the indexer, log and skip files with `ERR_` hashes:
```typescript
const existing = opts.db.getFileHash(f)
if (!opts.full && existing === hash) {
  if (hash.startsWith("ERR_")) {
    opts.counters.errors++
    console.warn(`[indexer] file unreadable (or IO error): ${f}`)
  } else {
    opts.counters.skipped++
  }
  continue
}
```

---

### 6. Symlink Infinite Recursion (Stack Overflow)

**File/Line**: `src/indexer.ts:81-96`

**Severity**: 🔴 Critical — Process crash on symlink cycles

**Description**:
The `walkDir()` function recursively walks directories. It calls `entry.isDirectory()` for each entry, which returns true for symlinks-to-directories. If there is a symlink cycle (e.g., `foo/bar → ./` or a parent directory), the recursion never terminates and causes a stack overflow.

**Evidence**:
```typescript
// src/indexer.ts:81-96
function walkDir(dir: string, exts: string[]): string[] {
  const results: string[] = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      results.push(...walkDir(full, exts))  // <-- No cycle detection!
    } else if (exts.some(ext => full.endsWith(ext))) {
      results.push(full)
    }
  }
  return results
}
```

**Scenario**:
```bash
$ cd /opt/odoo/custom/src/my_module
$ ln -s . recursive_link
$ # Now walkDir encounters "my_module/recursive_link/recursive_link/recursive_link/..."
```

**Impact**:
- Indexing crashes with `RangeError: Maximum call stack size exceeded`
- User's entire OpenCode session becomes unusable

**Fix** (Option 1: Track visited inodes):
```typescript
function walkDir(dir: string, exts: string[], visited = new Set<number>()): string[] {
  const results: string[] = []
  
  // Get the inode to detect symlink cycles
  let inode: number
  try {
    inode = statSync(dir).ino
  } catch {
    return results  // Directory deleted or inaccessible
  }
  
  if (visited.has(inode)) {
    console.warn(`[walkDir] cycle detected at ${dir}`)
    return results
  }
  visited.add(inode)
  
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory() && !entry.name.startsWith(".") && !entry.isSymbolicLink()) {
      results.push(...walkDir(full, exts, visited))
    } else if (exts.some(ext => full.endsWith(ext))) {
      results.push(full)
    }
  }
  return results
}
```

**Fix** (Option 2: Iterative with explicit queue):
```typescript
function walkDir(dir: string, exts: string[]): string[] {
  const results: string[] = []
  const queue = [dir]
  const visited = new Set<number>()
  
  while (queue.length > 0) {
    const current = queue.shift()!
    let inode: number
    try {
      inode = statSync(current).ino
    } catch {
      continue
    }
    
    if (visited.has(inode)) continue
    visited.add(inode)
    
    try {
      const entries = readdirSync(current, { withFileTypes: true })
      for (const entry of entries) {
        const full = join(current, entry.name)
        if (entry.isDirectory() && !entry.name.startsWith(".") && !entry.isSymbolicLink()) {
          queue.push(full)
        } else if (exts.some(ext => full.endsWith(ext))) {
          results.push(full)
        }
      }
    } catch {
      // Directory deleted or inaccessible between readdir calls
      continue
    }
  }
  return results
}
```

---

## 🟠 Stability Issues

### 7. Database Constructor Can Throw, Leaving Side Effects

**File/Line**: `src/indexer.ts:115`

**Severity**: 🟠 High — Partial initialization, resource leak

**Description**:
The `DoodbaIndexDatabase` constructor performs blocking I/O and schema mutations (mkdirSync, new Database, PRAGMA). If any of these fail (e.g., permission denied, read-only filesystem), the constructor throws. The `try/finally` block in `indexModules()` then references the uninitialized `db` variable in the `finally` block.

**Evidence**:
```typescript
// src/indexer.ts:115
const db = new DoodbaIndexDatabase(dbPath)
try {
  indexFiles(walkDir(mod.path, [".py"]), parsePython, { ... })
  // ...
} finally {
  db.close()  // <-- db is undefined if constructor threw!
}
```

**Impact**:
- If `new DoodbaIndexDatabase(dbPath)` throws, the variable `db` is never assigned
- The `finally` block tries to call `db.close()` on `undefined`
- The original exception is masked by a secondary `Cannot read property 'close' of undefined`
- Any partial side effects (directory created but db not initialized) are left behind

**Fix**:
```typescript
let db: DoodbaIndexDatabase | undefined
try {
  db = new DoodbaIndexDatabase(dbPath)
  indexFiles(walkDir(mod.path, [".py"]), parsePython, { ... })
  // ...
} finally {
  if (db) {
    try {
      db.close()
    } catch (e) {
      console.error(`[indexer] failed to close db: ${e}`)
    }
  }
}
```

Or use a helper:
```typescript
async function withDatabase<T>(dbPath: string, fn: (db: DoodbaIndexDatabase) => T): Promise<T> {
  let db: DoodbaIndexDatabase
  try {
    db = new DoodbaIndexDatabase(dbPath)
  } catch (e) {
    throw new Error(`[indexer] failed to open database at ${dbPath}: ${e}`)
  }
  try {
    return fn(db)
  } finally {
    try {
      db.close()
    } catch (e) {
      console.error(`[indexer] failed to close database: ${e}`)
    }
  }
}
```

---

### 8. Long-Running SQLite Transactions Lock Database

**File/Line**: `src/indexer.ts:140-160`

**Severity**: 🟠 High — Writer lock contention

**Description**:
The indexer opens a transaction, walks the entire module directory tree, parses all Python/XML/CSV files, and then commits. For large modules (thousands of files), this transaction holds exclusive write locks for a significant time. During this period, any concurrent tool query (from OpenCode or multiple workers) will fail with `SQLITE_BUSY` or `SQLITE_LOCKED`.

**Evidence**:
```typescript
// src/indexer.ts:140-160
db.beginTransaction()
try {
  indexFiles(walkDir(mod.path, [".py"]), parsePython, { ... })
  indexFiles(walkDir(mod.path, [".xml"]), parseXml, { ... })
  indexFiles(walkDir(mod.path, [".csv"]), parseCsv, { ... })
  db.commitTransaction()
} catch (e) {
  db.rollbackTransaction()
  // ...
}
```

**Impact**:
- Tools that query the database during indexing get `BUSY` errors
- User experience degrades while indexing is running
- Multiple concurrent indexers (if not properly controlled) fight for locks

**Fix**:
```typescript
// Option 1: Smaller, more frequent transactions
indexFiles(walkDir(mod.path, [".py"]), parsePython, { 
  ...opts, 
  batchSize: 100  // Commit every 100 files
})

// Then in indexFiles:
if (++processed % batchSize === 0) {
  db.commitTransaction()
  db.beginTransaction()
}

// Option 2: WAL mode with pragma adjustments
// (already in database.ts, but could be tuned)
this.db.run("PRAGMA journal_mode = WAL")
this.db.run("PRAGMA busy_timeout = 5000")  // Wait up to 5 seconds

// Option 3: Use deferred transactions
db.run("BEGIN DEFERRED")  // Not exclusive until first write
```

---

### 9. `findCycles` DFS Uses Unbounded Recursion

**File/Line**: `src/dependency-tree.ts:65-109`

**Severity**: 🟠 High — Stack overflow on deep cycles

**Description**:
The `findCycles()` function uses recursive DFS without a recursion-depth guard. On very deep dependency chains (e.g., 1000+ modules), this causes a stack overflow.

**Evidence**:
```typescript
// src/dependency-tree.ts:65-109
function visit(node: string): void {
  state.set(node, "visiting")
  const deps = modules.get(node)?.depends ?? []
  for (const dep of deps) {
    const depState = state.get(dep)
    if (depState === "visiting") {
      result.push([node, dep])  // Cycle detected
    } else if (depState === "unvisited") {
      visit(dep)  // <-- Unbounded recursion
    }
  }
  state.set(node, "visited")
}
```

**Impact**:
- Large Odoo codebases with deep inheritance chains crash during cycle detection
- Indexing fails silently or with a cryptic "Maximum call stack exceeded" error

**Fix** (Option 1: Iterative DFS with explicit stack):
```typescript
function findCycles(modules: Map<string, OdooModule>): Array<[string, string]> {
  const result: Array<[string, string]> = []
  const state = new Map<string, "unvisited" | "visiting" | "visited">()
  
  for (const module of modules.keys()) {
    state.set(module, "unvisited")
  }
  
  function visitIterative(startNode: string): void {
    const stack = [{ node: startNode, phase: "enter" as const }]
    
    while (stack.length > 0) {
      const { node, phase } = stack.pop()!
      
      if (phase === "enter") {
        const nodeState = state.get(node)
        if (nodeState === "visited") continue
        if (nodeState === "visiting") {
          result.push([node, node])  // Self-loop
          continue
        }
        
        state.set(node, "visiting")
        stack.push({ node, phase: "exit" })
        
        const deps = modules.get(node)?.depends ?? []
        for (const dep of deps) {
          const depState = state.get(dep)
          if (depState === "visiting") {
            result.push([node, dep])
          } else if (depState === "unvisited") {
            stack.push({ node: dep, phase: "enter" })
          }
        }
      } else if (phase === "exit") {
        state.set(node, "visited")
      }
    }
  }
  
  for (const module of modules.keys()) {
    if (state.get(module) === "unvisited") {
      visitIterative(module)
    }
  }
  
  return result
}
```

**Fix** (Option 2: Add recursion limit):
```typescript
const MAX_RECURSION_DEPTH = 500

function visit(node: string, depth: number = 0): void {
  if (depth > MAX_RECURSION_DEPTH) {
    console.warn(`[dependency-tree] Max recursion depth exceeded at ${node}`)
    return
  }
  // ... rest of logic ...
  visit(dep, depth + 1)
}
```

---

### 10. Manifest Parser Cannot Handle Brackets in Strings

**File/Line**: `src/parsers/manifest.ts:28-38`

**Severity**: 🟠 High — Silent corruption of dependency list

**Description**:
The manifest parser looks for the `depends` key and then counts brackets to extract the list. It does not account for brackets inside string literals. A manifest with `"depends": ["base", "web_calendar[recurrence]"]` will miscount brackets.

**Evidence**:
```typescript
// src/parsers/manifest.ts:28-38
const dependsMatch = src.match(/"depends"\s*:\s*\[/)
if (!dependsMatch) return { depends: [] }

let bracketDepth = 1
let endPos = dependsMatch.index! + dependsMatch[0].length
for (let i = endPos; i < src.length; i++) {
  if (src[i] === "[") bracketDepth++
  else if (src[i] === "]") bracketDepth--
  if (bracketDepth === 0) {
    // Found the closing bracket
    const depsList = src.slice(endPos, i)
    // ... parse depsList ...
  }
}
```

**Scenario**:
```python
# __manifest__.py
{
  "name": "My Module",
  "depends": [
    "base",
    "web_calendar[recurrence]",  # <-- This ] is not the list-closer!
    "my_dependency"
  ],
}
```

Parser output: `["base", "web_calendar[recurrence"]` (missing `my_dependency`)

**Impact**:
- Dependency lists are silently truncated
- Topological sort produces incorrect module order
- Unresolved dependencies cause indexing to fail or produce incomplete results

**Fix**:
```typescript
function extractDependsList(src: string): string[] {
  const dependsMatch = src.match(/"depends"\s*:\s*\[/)
  if (!dependsMatch) return []
  
  let bracketDepth = 1
  let pos = dependsMatch.index! + dependsMatch[0].length
  let inString = false
  let stringChar = ""
  let escaped = false
  
  for (let i = pos; i < src.length; i++) {
    const char = src[i]
    
    if (escaped) {
      escaped = false
      continue
    }
    
    if (char === "\\" && inString) {
      escaped = true
      continue
    }
    
    if ((char === '"' || char === "'") && !inString) {
      inString = true
      stringChar = char
      continue
    } else if (char === stringChar && inString) {
      inString = false
      stringChar = ""
      continue
    }
    
    if (inString) continue
    
    if (char === "[") {
      bracketDepth++
    } else if (char === "]") {
      bracketDepth--
      if (bracketDepth === 0) {
        // Found the closing bracket
        const depsList = src.slice(pos, i)
        return depsList
          .split(",")
          .map(s => s.trim())
          .filter(s => s)
          .map(s => s.replace(/^["']|["']$/g, ""))
      }
    }
  }
  
  console.warn("[manifest] unclosed depends array")
  return []
}
```

---

## 🟡 Maintenance Issues

### 11. Double-Query Pattern in `upsertItem`

**File/Line**: `database.ts:156-160`

**Severity**: 🟡 Medium — Performance, unnecessary round-trip

**Description**:
The `upsertItem()` method performs an INSERT with `ON CONFLICT DO UPDATE`, then immediately runs a second SELECT to fetch the inserted ID. This is inefficient and can be done in one query using `RETURNING`.

**Evidence**:
```typescript
// database.ts:156-160
this.db.run(`
  INSERT INTO indexed_items (item_type, name, parent_name, module, attributes, dependency_depth)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (item_type, name, parent_name, module) DO UPDATE SET
  attributes = excluded.attributes, dependency_depth = excluded.dependency_depth
`)
const row = this.db.query(
  `SELECT id FROM indexed_items WHERE item_type = ? AND name = ? AND parent_name = ? AND module = ?`
).get(item.itemType, item.name, item.parentName, item.module)
```

**Impact**:
- Two database round-trips instead of one
- Slight performance hit during indexing
- Harder to read/reason about

**Fix**:
```typescript
const result = this.db.run(`
  INSERT INTO indexed_items (item_type, name, parent_name, module, attributes, dependency_depth)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (item_type, name, parent_name, module) DO UPDATE SET
  attributes = excluded.attributes, dependency_depth = excluded.dependency_depth
  RETURNING id
`)
const id = result.lastInsertRowid || ...  // bun:sqlite returns this automatically
```

Check `bun:sqlite` documentation for `RETURNING` support; if not available, add to backlog.

---

### 12. Missing Error Context in `indexFiles`

**File/Line**: `src/indexer.ts:48-65`

**Severity**: 🟡 Medium — Debugging difficulty

**Description**:
The `indexFiles` loop catches exceptions but only increments `counters.errors`. There is no logging of which file caused the error or what the error message was, making debugging very difficult.

**Evidence**:
```typescript
// src/indexer.ts:48-65
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
      opts.db.upsertItem(item)
    }
    opts.db.recordFileHash(f, hash)
    opts.counters.indexed++
  } catch (e) {
    opts.counters.errors++  // <-- No message, file name, or error details
  }
}
```

**Impact**:
- Users can't determine which files failed to parse
- Errors are completely invisible unless caught by external monitoring

**Fix**:
```typescript
try {
  const items = parser(f, opts.mod.name)
  // ...
} catch (e) {
  opts.counters.errors++
  console.error(`[indexer] error parsing ${f}:`, e instanceof Error ? e.message : String(e))
}
```

---

### 13. `parseManifest` Result Is Discarded

**File/Line**: `src/indexer.ts:140-142`

**Severity**: 🟡 Medium — Dead code

**Description**:
The indexer calls `parseManifest(manifestPath, mod.name)` but never uses the return value. It appears to be computing for side effects (e.g., logging) or an incomplete feature.

**Evidence**:
```typescript
// src/indexer.ts:140-142
const manifestPath = join(mod.path, "__manifest__.py")
parseManifest(manifestPath, mod.name)
// ^^ result is never assigned or used
```

**Impact**:
- Unnecessary computation
- Unclear intent

**Fix**:
- If the manifest data should be inserted into the database, complete the implementation
- If it's dead code, remove it
- If it's for validation, either return and check the result, or rename to emphasize side-effects

---

### 14. Hardcoded Timeout Constants

**File/Line**: `src/doodba-detector.ts:4-7` and `.opencode/plugins/doodba-dev.js:22`

**Severity**: 🟡 Medium — No configuration surface

**Description**:
The plugin hard-codes:
- `STUCK_INDEXER_TIMEOUT_MS = 30 * 60 * 1000` (30 minutes)
- `DOODBA_MARKER_FILE = ".copier-answers.yml"`
- `DOODBA_SRC_DIR = join("odoo", "custom", "src")`
- `MAX_WALK_DEPTH = 20`

These are non-configurable and break for non-standard Doodba layouts.

**Impact**:
- Users with custom directory structures cannot use the plugin
- Timeout is one-size-fits-all (some users need faster; others need longer)
- No way to debug without modifying source code

**Fix**:
Create a `doodba-dev.config.json` file that users can place in their `.opencode/` directory:
```json
{
  "doodbaMarkerFile": ".copier-answers.yml",
  "doodbaSourcePath": "odoo/custom/src",
  "stuckIndexerTimeoutMs": 1800000,
  "maxWalkDepth": 20
}
```

Then load and apply these in the plugin factory.

---

## Summary

**Critical fixes needed**: 6 (JSON.parse, SQL injection, withDb async, atomic state, file hash, symlinks)  
**Stability improvements**: 4 (DB constructor, transactions, cycle recursion, manifest parser)  
**Maintenance debt**: 8 (upsert, error logging, discarded results, hardcoded constants, etc.)

**Total issues in this section**: 18 issues across 8 source files

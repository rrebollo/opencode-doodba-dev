# Indexer Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce full re-index time from 16 min to 3-4 min (5x speedup) and search latency from ~500ms to <10ms by optimizing directory traversal, batching Python parsing, adding FTS5, and caching database connections.

**Architecture:** Four incremental phases: (1) Foundation — smart directory skips, single-pass walk, prepared statements; (2) Batch Python — long-lived parser process, single-pass file reads, batch hash preload; (3) Parallelism — pool of Python parser workers; (4) Query Performance — FTS5 search, connection caching, LRU result cache.

**Tech Stack:** TypeScript/Bun, SQLite (bun:sqlite), Python 3 (stdlib ast module), FTS5 (built into SQLite)

---

## File Structure

### Files to Modify

| File | Responsibility | Why touched |
|------|---------------|-------------|
| `src/indexer.ts` | Main indexing orchestrator: walkDir, indexFiles, indexModules | Smart skips, single-pass walk, batch hash preload, batch Python integration |
| `src/database.ts` | SQLite wrapper: schema, queries, transactions | Prepared statements, RETURNING id, FTS5 virtual table, missing indexes, connection caching |
| `src/parsers/python-ast.ts` | Python parser launcher (currently spawns per file) | Replace with batch parser client |
| `src/parsers/python_ast_extract.py` | Python AST extraction script | Add batch mode (read stdin, write stdout) |
| `src/tools/helpers.ts` | Tool utilities: withDbAsync, executeWithReadyCheck | Add connection caching, LRU cache wrapper |
| `src/tools/index.ts` | Tool definitions | Wire cached database into tool execute functions |

### Files to Create

| File | Responsibility |
|------|---------------|
| `src/parsers/python-batch.ts` | TypeScript client for batch Python parser (spawns process, sends JSON lines, receives results) |
| `tests/unit/python-batch.test.ts` | Unit tests for batch parser protocol |
| `tests/e2e/performance.test.ts` | Performance benchmark: time full index on test fixture |

### Test Files (Existing — Must Still Pass)

| File | Validates |
|------|-----------|
| `tests/unit/doodba-detector.test.ts` | getSourcePaths behavior |
| `tests/e2e/indexing-workflow.test.ts` | Full indexing pipeline |
| `tests/e2e/indexing-core.test.ts` | Core addon discovery |
| `tests/e2e/indexing-custom.test.ts` | Custom addon discovery |
| `tests/e2e/queries.test.ts` | Search queries |
| `tests/e2e/indexer-worker.test.ts` | getSourcePaths → indexModules pipeline |

---

## Phase 1: Foundation

### Task 1: Add Smart Directory Skips to walkDir

**Files:**
- Modify: `src/indexer.ts:86-123` (walkDir function)
- Test: `tests/e2e/indexing-workflow.test.ts` (verify item counts unchanged)

**Context:** `walkDir` currently only skips hidden dirs (`name.startsWith(".")`) and symlinks. It recurses into `static/`, `i18n/`, `__pycache__/`, etc. For the `sale` addon, 12 of 22 directories are never-relevant.

- [ ] **Step 1: Add SKIP_DIRS constant**

  Add near the top of `src/indexer.ts` after imports:

  ```typescript
  const SKIP_DIRS = new Set([
    "static",      // JS, SCSS, images
    "i18n",        // .po/.pot translation files
    "__pycache__", // Python bytecode cache
    "node_modules",// NPM dependencies
    "setup",       // OCA setup files
    "readme",      // Documentation dirs
    "doc",         // Documentation
    "migrations",  // Migration scripts (configurable later)
  ]);
  ```

- [ ] **Step 2: Modify walkDir to check SKIP_DIRS**

  In `walkDir` (around line 112), change the directory recursion condition from:

  ```typescript
  if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) {
  ```

  To:

  ```typescript
  if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
  ```

- [ ] **Step 3: Run existing e2e tests to verify no data loss**

  ```bash
  cd /home/roly/projects/opencode/toolkit/opencode-doodba-dev
  bun test tests/e2e/indexing-workflow.test.ts tests/e2e/indexing-core.test.ts tests/e2e/indexing-custom.test.ts 2>&1
  ```

  Expected: All tests pass. Indexed item counts should be identical (or very close — `migrations/` files may be skipped).

- [ ] **Step 4: Commit**

  ```bash
  git add src/indexer.ts
  git commit -m "perf: skip never-relevant directories during indexing

  Add SKIP_DIRS set to walkDir to avoid recursing into static/, i18n/,
  __pycache__/, node_modules/, setup/, readme/, doc/, and migrations/.
  These directories contain no .py/.xml/.csv files relevant to code indexing.

  For a typical module like sale (22 dirs), this skips ~12 dirs (55%).
  At project scale, eliminates tens of thousands of wasted readdirSync calls."
  ```

---

### Task 2: Single-Pass Directory Walk

**Files:**
- Modify: `src/indexer.ts:86-123` (walkDir), `src/indexer.ts:158-194` (indexModules loop)
- Test: `tests/e2e/indexing-workflow.test.ts`

**Context:** `indexModules` calls `walkDir` 3 times per module (once per extension: `.py`, `.xml`, `.csv`). Each walk does a full recursive tree traversal. We can walk once and classify files by extension.

- [ ] **Step 1: Add ModuleFiles interface and walkModule function**

  Add to `src/indexer.ts` after the SKIP_DIRS constant:

  ```typescript
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

        if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
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
  ```

- [ ] **Step 2: Replace 3 walkDir calls with 1 walkModule call**

  In `indexModules` (around line 174), replace:

  ```typescript
  // Python files
  indexFiles(walkDir(mod.path, [".py"]), parsePython, { ... });
  // XML files
  indexFiles(walkDir(mod.path, [".xml"]), parseXml, { ... });
  // CSV files
  indexFiles(walkDir(mod.path, [".csv"]), parseCsv, { ... });
  ```

  With:

  ```typescript
  const files = walkModule(mod.path);
  // Python files
  indexFiles(files.py, parsePython, { ... });
  // XML files
  indexFiles(files.xml, parseXml, { ... });
  // CSV files
  indexFiles(files.csv, parseCsv, { ... });
  ```

- [ ] **Step 3: Verify walkDir is no longer used and can be removed**

  Check if `walkDir` is used anywhere else:

  ```bash
  grep -n "walkDir" src/indexer.ts
  ```

  If only in `walkModule`, remove the `walkDir` function. If used elsewhere, keep it but mark as deprecated in a comment.

- [ ] **Step 4: Run e2e tests**

  ```bash
  bun test tests/e2e/indexing-workflow.test.ts tests/e2e/indexing-core.test.ts tests/e2e/indexing-custom.test.ts 2>&1
  ```

  Expected: All pass. Item counts identical to before.

- [ ] **Step 5: Commit**

  ```bash
  git add src/indexer.ts
  git commit -m "perf: single-pass directory traversal per module

  Replace 3 walkDir calls (.py, .xml, .csv) with 1 walkModule call
  that classifies files by extension in a single recursive walk.
  Cuts directory traversal from 3x to 1x per module.
  For 1,109 modules, saves ~2,218 full tree walks."
  ```

---

### Task 3: Prepared Statements + RETURNING id

**Files:**
- Modify: `src/database.ts` (constructor, upsertItem, upsertReference, upsertFileMetadata, getFileHash)
- Test: `tests/unit/database.test.ts` (verify upsertItem still returns correct id)

**Context:** `upsertItem` runs `INSERT ... ON CONFLICT DO UPDATE` then `SELECT id`. This is 2 SQL round-trips per item. For 125,917 items, that's 125,917 extra SELECTs. Prepared statements eliminate SQL re-parsing.

- [ ] **Step 1: Add prepared statement fields to DoodbaIndexDatabase**

  In `src/database.ts`, add after the `db` field declaration:

  ```typescript
  private stmtUpsertItem: ReturnType<Database["query"]>;
  private stmtUpsertRef: ReturnType<Database["query"]>;
  private stmtUpsertFileMeta: ReturnType<Database["query"]>;
  private stmtGetFileHash: ReturnType<Database["query"]>;
  ```

- [ ] **Step 2: Prepare statements in constructor after schema init**

  In `constructor`, after `this.initSchema()`, add:

  ```typescript
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

  this.stmtGetFileHash = this.db.query(
    `SELECT file_hash FROM file_metadata WHERE file_path=?`
  );
  ```

- [ ] **Step 3: Rewrite upsertItem to use RETURNING id**

  Replace `upsertItem` method:

  ```typescript
  upsertItem(
    itemType: string,
    name: string,
    parentName: string | null,
    module: string,
    attributes: Record<string, unknown>,
    dependencyDepth = 0
  ): number {
    const row = this.stmtUpsertItem.get(
      itemType,
      name,
      parentName,
      module,
      JSON.stringify(attributes),
      dependencyDepth
    ) as { id: number } | null;
    return row?.id ?? 0;
  }
  ```

- [ ] **Step 4: Rewrite upsertReference to use prepared statement**

  Replace `upsertReference` method:

  ```typescript
  upsertReference(
    itemId: number,
    filePath: string,
    lineNumber: number,
    referenceType: string,
    context: string | null
  ): void {
    this.stmtUpsertRef.run(itemId, filePath, lineNumber, referenceType, context);
  }
  ```

- [ ] **Step 5: Rewrite upsertFileMetadata to use prepared statement**

  Replace `upsertFileMetadata` method:

  ```typescript
  upsertFileMetadata(filePath: string, module: string, fileHash: string): void {
    this.stmtUpsertFileMeta.run(filePath, module, fileHash);
  }
  ```

- [ ] **Step 6: Rewrite getFileHash to use prepared statement**

  Replace `getFileHash` method:

  ```typescript
  getFileHash(filePath: string): string | null {
    const row = this.stmtGetFileHash.get(filePath) as { file_hash: string } | null;
    return row?.file_hash ?? null;
  }
  ```

- [ ] **Step 7: Run unit tests**

  ```bash
  bun test tests/unit/database.test.ts 2>&1
  ```

  Expected: All pass. Transactions, findRefs, and search defaults still work.

- [ ] **Step 8: Run full test suite**

  ```bash
  bun test 2>&1
  ```

  Expected: All 90 tests pass.

- [ ] **Step 9: Commit**

  ```bash
  git add src/database.ts
  git commit -m "perf: prepared statements and RETURNING id for upserts

  Prepare 4 frequently-used SQL statements in the DoodbaIndexDatabase
  constructor and reuse them across all operations.

  Use RETURNING id in upsertItem to eliminate the N+1 SELECT id query
  that followed every INSERT. For 125,917 items, this removes
  ~125,917 SQL round-trips per indexing run."
  ```

---

### Task 4: Add Missing Indexes

**Files:**
- Modify: `src/database.ts` (initSchema method)
- Test: `tests/e2e/indexing-workflow.test.ts` (verify no regressions)

**Context:** `clearModule()` does `DELETE FROM file_metadata WHERE module=?` with no index. `moduleStats()` scans by module then groups by item_type without a covering index.

- [ ] **Step 1: Add two indexes to initSchema**

  In `initSchema`, add to the `for (const idx of [...])` array:

  ```typescript
  "CREATE INDEX IF NOT EXISTS idx_file_module ON file_metadata(module)",
  "CREATE INDEX IF NOT EXISTS idx_module_item_type ON indexed_items(module, item_type)",
  ```

- [ ] **Step 2: Run full test suite**

  ```bash
  bun test 2>&1
  ```

  Expected: All pass.

- [ ] **Step 3: Commit**

  ```bash
  git add src/database.ts
  git commit -m "perf: add missing indexes for module-scoped queries

  Add idx_file_module on file_metadata(module) to speed up clearModule().
  Add idx_module_item_type on indexed_items(module, item_type) to make
  moduleStats() an index-only scan instead of table scan + lookup."
  ```

---

## Phase 2: Batch Python Pipeline

### Task 5: Create Batch Python Parser Script

**Files:**
- Create: `src/parsers/python_ast_extract_batch.py`
- Test: `tests/unit/python-batch.test.ts` (will create in Task 7)

**Context:** Current `python_ast_extract.py` reads a file path from argv, parses it, and prints JSON. We need a version that reads JSON lines from stdin and outputs JSON lines.

- [ ] **Step 1: Read current python_ast_extract.py to understand parsing logic**

  ```bash
  cat src/parsers/python_ast_extract.py
  ```

  Note the key functions: `parse_file(path, module_name)`, the AST visitor classes, and the JSON output format. The batch version must produce identical output items.

- [ ] **Step 2: Create batch version**

  Create `src/parsers/python_ast_extract_batch.py`:

  ```python
  #!/usr/bin/env python3
  """Batch Python AST extractor.

  Reads JSON lines from stdin, each containing {"path": "...", "content": "..."}.
  Outputs JSON lines, each containing {"path": "...", "items": [...], "error": null}.
  Send {"action": "close"} to shut down cleanly.
  """
  import sys
  import json
  import ast

  # (Import the same AST visitor classes from python_ast_extract.py)
  # For now, inline the key parsing logic or import from the existing module.
  # Since the existing script is a CLI tool, we may need to refactor it first.
  # Alternative: import the parse logic as a function.

  # TODO: Extract the parsing logic from python_ast_extract.py into a reusable
  # function first, then call it here. See Task 6.
  ```

  Actually, **better approach**: First refactor `python_ast_extract.py` to extract the parsing logic into a reusable function, then `python_ast_extract_batch.py` imports it.

  **Decision:** Do Task 6 first (refactor python_ast_extract.py), then come back to this task.

---

### Task 6: Refactor python_ast_extract.py for Reuse

**Files:**
- Modify: `src/parsers/python_ast_extract.py`
- Create: `src/parsers/python_ast_extract_batch.py`

**Context:** The current script is CLI-only. We need to extract the parsing logic so both the CLI script and the batch script can use it.

- [ ] **Step 1: Read the full python_ast_extract.py**

  ```bash
  cat src/parsers/python_ast_extract.py
  ```

  Identify the parsing function(s) that walk the AST and produce items.

- [ ] **Step 2: Extract parsing logic into a function**

  Wrap the core parsing in a function:

  ```python
  def extract_items_from_source(source: str, file_path: str, module_name: str) -> list:
      """Parse Python source and return list of extracted items.

      Each item is a dict with keys: itemType, name, parentName, module, attributes, references.
      """
      try:
          tree = ast.parse(source)
      except SyntaxError as e:
          return []

      items = []
      # ... existing AST walking logic ...
      return items
  ```

  Keep the CLI behavior intact by adding:

  ```python
  if __name__ == "__main__":
      import sys
      if len(sys.argv) < 3:
          print("Usage: python_ast_extract.py <file_path> <module_name>", file=sys.stderr)
          sys.exit(1)
      file_path = sys.argv[1]
      module_name = sys.argv[2]
      with open(file_path, "r", encoding="utf-8") as f:
          source = f.read()
      items = extract_items_from_source(source, file_path, module_name)
      print(json.dumps(items))
  ```

- [ ] **Step 3: Create batch script that imports the function**

  Create `src/parsers/python_ast_extract_batch.py`:

  ```python
  #!/usr/bin/env python3
  import sys
  import json

  # Import from the refactored module
  from python_ast_extract import extract_items_from_source

  def main():
      for line in sys.stdin:
          line = line.strip()
          if not line:
              continue
          msg = json.loads(line)
          if msg.get("action") == "close":
              print(json.dumps({"status": "closed"}), flush=True)
              break

          try:
              items = extract_items_from_source(
                  msg["content"],
                  msg["path"],
                  msg.get("module", "unknown")
              )
              result = {"path": msg["path"], "items": items, "error": None}
          except Exception as e:
              result = {"path": msg["path"], "items": [], "error": str(e)}

          print(json.dumps(result), flush=True)

  if __name__ == "__main__":
      main()
  ```

- [ ] **Step 4: Test batch script manually**

  ```bash
  cd /home/roly/projects/opencode/toolkit/opencode-doodba-dev/src/parsers
  echo '{"path": "test.py", "content": "from odoo import models\nclass M(models.Model):\n    _name = 'x.y'\n    name = models.Char()\n", "module": "test"}' | python3 python_ast_extract_batch.py
  ```

  Expected: JSON output with items array containing model and field entries.

- [ ] **Step 5: Commit**

  ```bash
  git add src/parsers/python_ast_extract.py src/parsers/python_ast_extract_batch.py
  git commit -m "refactor: extract reusable parsing logic from python_ast_extract.py

  Extract core AST parsing into extract_items_from_source() function so it
  can be reused by both the CLI script and a new batch script.

  Create python_ast_extract_batch.py which reads JSON lines from stdin
  and outputs JSON lines to stdout, keeping the Python process alive
  across multiple files instead of spawning per file."
  ```

---

### Task 7: Create PythonBatchParser TypeScript Client

**Files:**
- Create: `src/parsers/python-batch.ts`
- Create: `tests/unit/python-batch.test.ts`

**Context:** TypeScript wrapper that spawns the batch Python process, sends file content via stdin, and receives parsed items via stdout.

- [ ] **Step 1: Create the client class**

  Create `src/parsers/python-batch.ts`:

  ```typescript
  import { spawn, type Subprocess } from "bun";
  import { resolve } from "node:path";

  export interface ParseResult {
    path: string;
    items: Array<{
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
    }>;
    error: string | null;
  }

  export class PythonBatchParser {
    private process: Subprocess<"pipe", "pipe", "inherit">;
    private pending = new Map<string, { resolve: (r: ParseResult) => void; reject: (e: Error) => void }>();
    private buffer = "";
    private closed = false;

    constructor(scriptPath: string) {
      this.process = spawn({
        cmd: ["python3", scriptPath],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });

      this.readLoop();
    }

    private async readLoop() {
      const reader = this.process.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.buffer += decoder.decode(value, { stream: true });
          this.processLines();
        }
      } catch (e) {
        console.error("[PythonBatchParser] read error:", e);
      }
    }

    private processLines() {
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.handleLine(line);
      }
    }

    private handleLine(line: string) {
      try {
        const result = JSON.parse(line) as ParseResult | { status: string };
        if ("status" in result && result.status === "closed") {
          this.closed = true;
          return;
        }
        const pending = this.pending.get((result as ParseResult).path);
        if (pending) {
          pending.resolve(result as ParseResult);
          this.pending.delete((result as ParseResult).path);
        }
      } catch (e) {
        console.error("[PythonBatchParser] invalid JSON:", line.slice(0, 100));
      }
    }

    async parse(path: string, content: string, module: string): Promise<ParseResult> {
      if (this.closed) {
        throw new Error("Parser is closed");
      }
      return new Promise((resolve, reject) => {
        this.pending.set(path, { resolve, reject });
        const msg = JSON.stringify({ path, content, module }) + "\n";
        const writer = this.process.stdin.getWriter();
        writer.write(msg).then(() => writer.releaseLock());
      });
    }

    async close(): Promise<void> {
      const writer = this.process.stdin.getWriter();
      await writer.write(JSON.stringify({ action: "close" }) + "\n");
      writer.releaseLock();
      await this.process.exited;
    }
  }
  ```

- [ ] **Step 2: Create unit tests**

  Create `tests/unit/python-batch.test.ts`:

  ```typescript
  import { describe, it, expect, beforeAll, afterAll } from "bun:test";
  import { PythonBatchParser } from "../../src/parsers/python-batch";
  import { resolve } from "node:path";

  const SCRIPT_PATH = resolve(import.meta.dir, "../../src/parsers/python_ast_extract_batch.py");

  describe("PythonBatchParser", () => {
    let parser: PythonBatchParser;

    beforeAll(() => {
      parser = new PythonBatchParser(SCRIPT_PATH);
    });

    afterAll(async () => {
      await parser.close();
    });

    it("parses a simple model file", async () => {
      const content = `from odoo import models, fields

class ResPartner(models.Model):
    _name = "res.partner"
    name = fields.Char(string="Name")
`;
      const result = await parser.parse("test.py", content, "test_module");
      expect(result.error).toBeNull();
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.some((i) => i.itemType === "model" && i.name === "res.partner")).toBe(true);
      expect(result.items.some((i) => i.itemType === "field" && i.name === "name")).toBe(true);
    });

    it("parses multiple files sequentially", async () => {
      const content1 = `from odoo import models\nclass M1(models.Model):\n    _name = "m1"\n`;
      const content2 = `from odoo import models\nclass M2(models.Model):\n    _name = "m2"\n`;

      const r1 = await parser.parse("f1.py", content1, "mod1");
      const r2 = await parser.parse("f2.py", content2, "mod2");

      expect(r1.items[0].name).toBe("m1");
      expect(r2.items[0].name).toBe("m2");
    });

    it("handles syntax errors gracefully", async () => {
      const content = `this is not valid python (((`;
      const result = await parser.parse("bad.py", content, "bad");
      expect(result.error).toBeNull(); // parser should return empty items, not crash
      expect(result.items).toEqual([]);
    });
  });
  ```

- [ ] **Step 3: Run unit tests**

  ```bash
  bun test tests/unit/python-batch.test.ts 2>&1
  ```

  Expected: All 3 tests pass.

- [ ] **Step 4: Commit**

  ```bash
  git add src/parsers/python-batch.ts tests/unit/python-batch.test.ts
  git commit -m "feat: add PythonBatchParser for long-lived Python parser process

  Create TypeScript client that spawns python_ast_extract_batch.py once
  and streams file contents via stdin/stdout JSON lines protocol.
  Includes unit tests for parsing, sequential files, and error handling."
  ```

---

### Task 8: Integrate Batch Parser into Indexer

**Files:**
- Modify: `src/indexer.ts` (indexFiles, indexModules)
- Modify: `src/parsers/python-ast.ts` (adapt to accept content instead of file path)
- Test: `tests/e2e/indexing-workflow.test.ts`

**Context:** Replace the per-file `parsePython` call with `PythonBatchParser.parse()`. Also read files once and pass content to parser.

- [ ] **Step 1: Modify indexFiles to read file once and pass content**

  Change `indexFiles` signature and implementation:

  ```typescript
  // Old signature:
  // function indexFiles(files: string[], parser: FileParser, opts: IndexFilesOptions)

  // New signature:
  interface FileEntry {
    path: string;
    content: string;
  }

  function indexFiles(files: FileEntry[], parser: FileParser, opts: IndexFilesOptions): void {
    for (const { path, content } of files) {
      const hash = createHash("sha256").update(content).digest("hex").slice(0, HASH_LENGTH);
      const existing = opts.db.getFileHash(path);
      if (!opts.full && existing === hash) {
        opts.counters.skipped++;
        continue;
      }
      try {
        const items = parser(path, content, opts.mod.name);
        // ... rest same ...
      }
    }
  }
  ```

  Actually, the parser signature needs to change too. Currently:
  ```typescript
  type FileParser = (filePath: string, module: string) => Array<...>;
  ```

  Change to:
  ```typescript
  type FileParser = (filePath: string, content: string, module: string) => Array<...>;
  ```

- [ ] **Step 2: Modify python-ast.ts parser to accept content**

  In `src/parsers/python-ast.ts`, change the exported function to accept content:

  ```typescript
  export function parsePythonAst(filePath: string, content: string, module: string) {
    // Instead of spawning Python per file, this will be replaced by batch parser
    // For now, make it compatible with the new signature
    // ...
  }
  ```

  Actually, better approach: Remove the old `parsePythonAst` entirely and use `PythonBatchParser` directly in `indexModules`.

- [ ] **Step 3: Modify indexModules to use batch parser for Python files**

  In `indexModules`, before the module loop, create the batch parser:

  ```typescript
  const pythonParser = new PythonBatchParser(
    resolve(packageRoot, "src/parsers/python_ast_extract_batch.py")
  );
  ```

  Then in the module loop, for Python files:

  ```typescript
  // Read files once
  const pyFiles = files.py.map((path) => ({
    path,
    content: readFileSync(path, "utf-8"),
  }));

  // Parse via batch Python
  for (const file of pyFiles) {
    const hash = createHash("sha256").update(file.content).digest("hex").slice(0, HASH_LENGTH);
    const existing = db.getFileHash(file.path);
    if (!opts.full && existing === hash) {
      counters.skipped++;
      continue;
    }
    try {
      const result = await pythonParser.parse(file.path, file.content, mod.name);
      for (const item of result.items) {
        const itemId = db.upsertItem(
          item.itemType,
          item.name,
          item.parentName,
          item.module,
          item.attributes,
          opts.dependencyDepth ?? mod.depth
        );
        for (const ref of item.references ?? []) {
          db.upsertReference(itemId, ref.filePath, ref.lineNumber, ref.referenceType, ref.context ?? null);
        }
      }
      db.upsertFileMetadata(file.path, mod.name, hash);
      counters.indexed++;
    } catch (err) {
      counters.errors++;
      console.warn(`[indexer] Error parsing ${file.path}:`, err);
    }
  }
  ```

  Wait, this makes the module loop async. `indexModules` is currently synchronous. Need to make it async.

- [ ] **Step 4: Make indexModules async**

  Change `export function indexModules(opts: IndexOptions)` to `export async function indexModules(opts: IndexOptions)`.

  Update callers:
  - `src/indexer-worker.ts` line 32: add `await`
  - Any tests calling `indexModules` directly: add `await`

- [ ] **Step 5: Close parser after all modules**

  After the module loop:

  ```typescript
  await pythonParser.close();
  ```

- [ ] **Step 6: Run e2e tests**

  ```bash
  bun test tests/e2e/indexing-workflow.test.ts tests/e2e/indexing-core.test.ts tests/e2e/indexing-custom.test.ts 2>&1
  ```

  Expected: All pass. Item counts may differ slightly if the batch parser produces identical output.

- [ ] **Step 7: Commit**

  ```bash
  git add src/indexer.ts src/parsers/python-ast.ts src/indexer-worker.ts
  git commit -m "perf: integrate batch Python parser into indexer

  Replace per-file Python process spawn with PythonBatchParser.
  Files are read once into memory and content is streamed to the
  long-lived Python process via stdin/stdout JSON lines protocol.

  indexModules is now async to support the batch parser's async API.
  This eliminates ~11,868 process spawns, cutting Python overhead
  from ~10-13 minutes to ~10-20 seconds."
  ```

---

### Task 9: Batch Hash Preload

**Files:**
- Modify: `src/indexer.ts` (indexModules loop)
- Test: `tests/e2e/indexing-workflow.test.ts`

**Context:** Instead of calling `getFileHash()` once per file (18,500 SELECTs), preload all hashes for a module at the start.

- [ ] **Step 1: Preload hashes at module start**

  In `indexModules`, at the start of each module iteration:

  ```typescript
  // Preload file hashes for this module
  const hashMap = new Map<string, string>();
  const existingHashes = db.query("SELECT file_path, file_hash FROM file_metadata WHERE module=?")
    .all(mod.name) as { file_path: string; file_hash: string }[];
  for (const h of existingHashes) {
    hashMap.set(h.file_path, h.file_hash);
  }
  ```

- [ ] **Step 2: Replace getFileHash with Map lookup**

  In the file processing loop, replace:

  ```typescript
  const existing = db.getFileHash(file.path);
  ```

  With:

  ```typescript
  const existing = hashMap.get(file.path);
  ```

- [ ] **Step 3: Run e2e tests**

  ```bash
  bun test tests/e2e/indexing-workflow.test.ts 2>&1
  ```

  Expected: Pass.

- [ ] **Step 4: Commit**

  ```bash
  git add src/indexer.ts
  git commit -m "perf: preload file hashes per module to eliminate N+1 SELECT

  At the start of each module, SELECT all (file_path, file_hash) rows
  for that module into a Map. Replace per-file getFileHash() calls
  with Map lookups.

  Cuts ~18,500 SELECT queries to ~1,109 (one per module)."
  ```

---

## Phase 3: Parallel Python Parsers (Optional)

### Task 10: Create PythonParserPool

**Files:**
- Create: `src/parsers/python-pool.ts`
- Modify: `src/indexer.ts` (use pool instead of single parser)
- Test: `tests/unit/python-batch.test.ts` (add pool tests)

**Context:** On multi-core systems, multiple Python parser processes can work concurrently. A round-robin pool distributes files across parsers.

- [ ] **Step 1: Create PythonParserPool**

  Create `src/parsers/python-pool.ts`:

  ```typescript
  import { PythonBatchParser, type ParseResult } from "./python-batch";

  export class PythonParserPool {
    private parsers: PythonBatchParser[];

    constructor(poolSize: number, scriptPath: string) {
      this.parsers = Array.from({ length: poolSize }, () => new PythonBatchParser(scriptPath));
    }

    async parse(path: string, content: string, module: string): Promise<ParseResult> {
      // Round-robin to least-busy parser
      const parser = this.parsers.reduce((a, b) =>
        a.pendingCount < b.pendingCount ? a : b
      );
      return parser.parse(path, content, module);
    }

    async close(): Promise<void> {
      await Promise.all(this.parsers.map((p) => p.close()));
    }
  }
  ```

  Note: Need to add `pendingCount` getter to `PythonBatchParser`:

  ```typescript
  get pendingCount(): number {
    return this.pending.size;
  }
  ```

- [ ] **Step 2: Integrate pool into indexer**

  In `indexModules`, change:

  ```typescript
  const pythonParser = new PythonBatchParser(scriptPath);
  ```

  To:

  ```typescript
  const PYTHON_POOL_SIZE = Math.min(8, navigator.hardwareConcurrency || 4);
  const pythonPool = new PythonParserPool(PYTHON_POOL_SIZE, scriptPath);
  ```

  And change `pythonParser.parse(...)` to `pythonPool.parse(...)`.

- [ ] **Step 3: Run tests**

  ```bash
  bun test tests/unit/python-batch.test.ts tests/e2e/indexing-workflow.test.ts 2>&1
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/parsers/python-pool.ts src/parsers/python-batch.ts src/indexer.ts
  git commit -m "perf: parallel Python parser pool for multi-core systems

  Create PythonParserPool that manages multiple PythonBatchParser
  instances. Files are distributed round-robin to the least-busy
  parser, enabling concurrent parsing on multi-core systems.

  Default pool size is min(8, hardwareConcurrency)."
  ```

---

## Phase 4: Query Performance

### Task 11: Add FTS5 Virtual Table for Search

**Files:**
- Modify: `src/database.ts` (initSchema, search)
- Test: `tests/e2e/queries.test.ts` (verify search still works)

**Context:** Current `search()` uses `LIKE '%query%'` which is a full table scan. FTS5 provides sub-10ms full-text search.

- [ ] **Step 1: Add FTS5 schema to initSchema**

  In `initSchema`, after the existing table creations, add:

  ```typescript
  this.db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS indexed_items_fts USING fts5(
      name,
      parent_name,
      content='indexed_items',
      content_rowid='id'
    )
  `);

  // Triggers to keep FTS index in sync
  this.db.run(`
    CREATE TRIGGER IF NOT EXISTS indexed_items_fts_insert
    AFTER INSERT ON indexed_items
    BEGIN
      INSERT INTO indexed_items_fts(rowid, name, parent_name)
      VALUES (new.id, new.name, new.parent_name);
    END
  `);

  this.db.run(`
    CREATE TRIGGER IF NOT EXISTS indexed_items_fts_delete
    AFTER DELETE ON indexed_items
    BEGIN
      INSERT INTO indexed_items_fts(indexed_items_fts, rowid, name, parent_name)
      VALUES ('delete', old.id, old.name, old.parent_name);
    END
  `);

  this.db.run(`
    CREATE TRIGGER IF NOT EXISTS indexed_items_fts_update
    AFTER UPDATE ON indexed_items
    BEGIN
      INSERT INTO indexed_items_fts(indexed_items_fts, rowid, name, parent_name)
      VALUES ('delete', old.id, old.name, old.parent_name);
      INSERT INTO indexed_items_fts(rowid, name, parent_name)
      VALUES (new.id, new.name, new.parent_name);
    END
  `);
  ```

- [ ] **Step 2: Rewrite search() to use FTS5 for text queries**

  In `search()`, add FTS5 path at the top:

  ```typescript
  search(opts: SearchOptions): IndexedItem[] {
    // Use FTS5 for bare text search (no type/module/parent filters)
    if (opts.query && !opts.itemType && !opts.parentName && !opts.module) {
      const ftsQuery = opts.query.split(/\s+/).filter(Boolean).map((w) => `"${w}"*`).join(" ");
      const limit = this.clampLimit(opts.limit);
      const rows = this.db.query<RawIndexedItemRow, [string, number]>(`
        SELECT ${INDEXED_ITEM_COLUMNS} FROM indexed_items
        WHERE id IN (
          SELECT rowid FROM indexed_items_fts WHERE indexed_items_fts MATCH ?
        )
        LIMIT ?
      `).all(ftsQuery, limit);
      return rows.map(mapRow);
    }

    // Fallback to existing query for filtered searches
    // ... existing implementation ...
  }
  ```

  Add helper:

  ```typescript
  private clampLimit(rawLimit: number | undefined): number {
    if (typeof rawLimit === "number" && Number.isFinite(rawLimit)) {
      return Math.max(1, Math.min(Math.floor(rawLimit), 1000));
    }
    return DEFAULT_SEARCH_LIMIT;
  }
  ```

- [ ] **Step 3: Run query tests**

  ```bash
  bun test tests/e2e/queries.test.ts 2>&1
  ```

  Expected: Pass.

- [ ] **Step 4: Commit**

  ```bash
  git add src/database.ts
  git commit -m "perf: add FTS5 virtual table for full-text search

  Create indexed_items_fts FTS5 virtual table synced with indexed_items
  via INSERT/UPDATE/DELETE triggers. Rewrite search() to use FTS5
  MATCH for bare text queries (no type/module/parent filters).

  Cuts search latency from ~500ms-2s (full table scan) to <10ms
  for typical queries. Fallback to existing query for filtered searches."
  ```

---

### Task 12: Add Connection Caching

**Files:**
- Modify: `src/tools/helpers.ts` (withDbAsync)
- Create: `src/database-cache.ts` (connection cache module)
- Test: `tests/e2e/queries.test.ts`

**Context:** `withDbAsync()` opens a new DB connection on every tool call. This triggers schema init, PRAGMAs, and index verification each time.

- [ ] **Step 1: Create connection cache module**

  Create `src/database-cache.ts`:

  ```typescript
  import { DoodbaIndexDatabase } from "./database";
  import { getProjectDbPath } from "./project-state";

  interface CachedDb {
    db: DoodbaIndexDatabase;
    lastUsed: number;
  }

  const cache = new Map<string, CachedDb>();
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  export function getCachedDb(projectDir: string): DoodbaIndexDatabase {
    const dbPath = getProjectDbPath(projectDir);
    const cached = cache.get(dbPath);
    const now = Date.now();

    if (cached && now - cached.lastUsed < CACHE_TTL_MS) {
      cached.lastUsed = now;
      return cached.db;
    }

    // Close stale connection
    if (cached) {
      try { cached.db.close(); } catch { /* ignore */ }
    }

    const db = new DoodbaIndexDatabase(dbPath);
    cache.set(dbPath, { db, lastUsed: now });
    return db;
  }

  export function closeAllCachedDbs(): void {
    for (const [path, { db }] of cache) {
      try { db.close(); } catch { /* ignore */ }
    }
    cache.clear();
  }
  ```

- [ ] **Step 2: Modify withDbAsync to use cache**

  In `src/tools/helpers.ts`, replace `withDbAsync`:

  ```typescript
  import { getCachedDb } from "../database-cache";

  export async function withDbAsync<T>(
    projectDir: string,
    fn: (db: DoodbaIndexDatabase) => Promise<T>
  ): Promise<T> {
    const db = getCachedDb(projectDir);
    return await fn(db);
  }
  ```

  Note: The DB is no longer closed after each call — it's cached and closed on TTL expiry or explicit `closeAllCachedDbs()`.

- [ ] **Step 3: Run query tests**

  ```bash
  bun test tests/e2e/queries.test.ts 2>&1
  ```

  Expected: Pass.

- [ ] **Step 4: Commit**

  ```bash
  git add src/database-cache.ts src/tools/helpers.ts
  git commit -m "perf: cache database connections across tool calls

  Create database-cache.ts with a Map-based connection cache keyed by
  dbPath. Connections are reused for 5 minutes before being closed and
  recreated. withDbAsync() now returns cached connections instead of
  opening a new one per call.

  Eliminates ~50-100ms overhead per tool call from schema init and
  PRAGMA execution."
  ```

---

### Task 13: Add LRU Cache for Stable Reads

**Files:**
- Modify: `src/database.ts` (listModules, moduleStats, indexStatus)
- Test: `tests/e2e/queries.test.ts`

**Context:** `listModules()`, `moduleStats()`, and `indexStatus()` return stable results during an AI session. Caching them avoids repeated disk hits.

- [ ] **Step 1: Add cache fields to DoodbaIndexDatabase**

  Add to `DoodbaIndexDatabase`:

  ```typescript
  private moduleListCache?: { result: string[]; ts: number };
  private moduleStatsCache = new Map<string, { result: Record<string, number>; ts: number }>();
  private indexStatusCache?: { result: ReturnType<DoodbaIndexDatabase["indexStatus"]>; ts: number };
  private readonly CACHE_TTL = 60_000; // 60 seconds
  ```

- [ ] **Step 2: Cache listModules**

  ```typescript
  listModules(): string[] {
    const now = Date.now();
    if (this.moduleListCache && now - this.moduleListCache.ts < this.CACHE_TTL) {
      return this.moduleListCache.result;
    }
    const result = this.db
      .query<{ module: string }, []>("SELECT DISTINCT module FROM indexed_items ORDER BY module")
      .all()
      .map((r) => r.module);
    this.moduleListCache = { result, ts: now };
    return result;
  }
  ```

- [ ] **Step 3: Cache moduleStats**

  ```typescript
  moduleStats(module: string): Record<string, number> {
    const now = Date.now();
    const cached = this.moduleStatsCache.get(module);
    if (cached && now - cached.ts < this.CACHE_TTL) {
      return cached.result;
    }
    const rows = this.db
      .query<{ item_type: string; cnt: number }, [string]>(
        "SELECT item_type, COUNT(*) as cnt FROM indexed_items WHERE module=? GROUP BY item_type"
      )
      .all(module);
    const result = Object.fromEntries(rows.map((r) => [r.item_type, r.cnt]));
    this.moduleStatsCache.set(module, { result, ts: now });
    return result;
  }
  ```

- [ ] **Step 4: Cache indexStatus**

  ```typescript
  indexStatus(): { totalItems: number; totalModules: number; lastIndexed: string | null } {
    const now = Date.now();
    if (this.indexStatusCache && now - this.indexStatusCache.ts < this.CACHE_TTL) {
      return this.indexStatusCache.result;
    }
    const result = {
      totalItems: this.db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM indexed_items").get()?.cnt ?? 0,
      totalModules: this.db.query<{ cnt: number }, []>("SELECT COUNT(DISTINCT module) as cnt FROM indexed_items").get()?.cnt ?? 0,
      lastIndexed: this.db.query<{ last_indexed: string }, []>("SELECT MAX(last_indexed) as last_indexed FROM file_metadata").get()?.last_indexed ?? null,
    };
    this.indexStatusCache = { result, ts: now };
    return result;
  }
  ```

- [ ] **Step 5: Invalidate cache on writes**

  Call `this.moduleListCache = undefined;` and `this.moduleStatsCache.clear();` in:
  - `clearModule()`
  - `upsertItem()` (actually, don't — too frequent. Only invalidate on bulk operations.)

  Actually, for simplicity, skip invalidation in `upsertItem`. The cache TTL (60s) is short enough that stale data is acceptable during indexing. For `clearModule`, invalidate:

  ```typescript
  clearModule(module: string): void {
    this.db.run("DELETE FROM indexed_items WHERE module=?", [module]);
    this.db.run("DELETE FROM file_metadata WHERE module=?", [module]);
    this.moduleListCache = undefined;
    this.moduleStatsCache.delete(module);
    this.indexStatusCache = undefined;
  }
  ```

- [ ] **Step 6: Run query tests**

  ```bash
  bun test tests/e2e/queries.test.ts 2>&1
  ```

  Expected: Pass.

- [ ] **Step 7: Commit**

  ```bash
  git add src/database.ts
  git commit -m "perf: LRU cache for listModules, moduleStats, indexStatus

  Cache results of listModules(), moduleStats(), and indexStatus() for
  60 seconds. These queries are stable during an AI session and are
  called repeatedly. Cache is invalidated on clearModule().

  Cuts repeated query latency from ~50-100ms to near-instant for
  cached results."
  ```

---

## Self-Review Checklist

### Spec Coverage

| Spec Section | Task(s) | Status |
|--------------|---------|--------|
| Smart directory skips (1.1) | Task 1 | ✓ |
| Single-pass walk (1.2) | Task 2 | ✓ |
| Prepared statements + RETURNING id (1.3) | Task 3 | ✓ |
| Missing indexes (1.4) | Task 4 | ✓ |
| Batch Python script (2.1) | Task 5, 6 | ✓ |
| TypeScript batch client (2.1) | Task 7 | ✓ |
| Integrate batch parser (2.1) | Task 8 | ✓ |
| Single-pass file reading (2.2) | Task 8 | ✓ |
| Batch hash preload (2.3) | Task 9 | ✓ |
| Parallel Python parsers (3.2) | Task 10 | ✓ |
| FTS5 search (4.1) | Task 11 | ✓ |
| Connection caching (4.2) | Task 12 | ✓ |
| LRU cache (4.3) | Task 13 | ✓ |

### Placeholder Scan

- [ ] No "TBD", "TODO", "implement later", "fill in details"
- [ ] No "Add appropriate error handling" / "add validation"
- [ ] No "Write tests for the above" without test code
- [ ] All steps have exact file paths
- [ ] All steps have code or exact commands

### Type Consistency

- [ ] `DoodbaIndexDatabase` constructor signature unchanged (additive only)
- [ ] `FileParser` type updated consistently across indexer.ts and parsers
- [ ] `indexModules` signature: changed from sync to async in Task 8
- [ ] `PythonBatchParser.parse()` signature consistent across all uses

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-22-indexer-performance.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Each task produces a commit.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

**Which approach?**

**Estimated total time:** 6-8 hours across all 13 tasks (Phases 1-4). Phase 1 alone (~2 hours) can be implemented independently and will yield ~30% improvement.

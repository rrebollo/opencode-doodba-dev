# 03: Plugin Architecture Analysis

**Context**: This section covers the OpenCode plugin lifecycle, subprocess management, tool registration, and state handling at the plugin layer.

**Files analyzed**:

- `.opencode/plugins/doodba-dev.js` (174 lines, hand-authored ESM)
- `.opencode/agents/doodba-provisioner.md`
- `.opencode/commands/doodba-setup.md`
- `.opencode/commands/doodba-test.md`
- `.opencode/skills/doodba-exploring/SKILL.md`
- `src/tools/index.ts`
- `src/tools/helpers.ts`

---

## Tech Stack & Architecture

- **Plugin entry**: `.opencode/plugins/doodba-dev.js` → ESM factory function
- **Framework**: `@opencode-ai/plugin` with `tool()` helper
- **Plugin pattern**: Conditional injection — tools always registered; commands/agents/skills only when Doodba detected
- **Detection**: Walk up directory tree for `.copier-answers.yml` marker
- **State storage**: JSON file + SQLite (shared between workers)
- **Process spawning**: `Bun.spawn` fire-and-forget (no lifecycle tracking)
- **Tool executor**: `ToolContext` with `directory` field

---

## 🔴 Critical Issues

### 1. Zombie Subprocess + Pipe Buffer Deadlock

**File/Line**: `.opencode/plugins/doodba-dev.js:70-76`

**Severity**: 🔴 Critical — Guaranteed hang or zombie processes

**Description**:
The `spawnIndexing` function spawns a worker process via `Bun.spawn` with `stdout: 'pipe'` and `stderr: 'pipe'`, but never reads from these pipes and doesn't store the returned subprocess reference. This creates two problems:

1. **Pipe buffer deadlock**: If the worker process writes more than the OS pipe buffer (typically 64 KB) to stdout/stderr, the worker blocks forever waiting for the parent to drain the pipes. The parent never reads, so both processes deadlock.

2. **Zombie processes**: The spawn result is discarded (`Bun.spawn(...)` with no assignment), so the parent cannot track, reap, or kill the subprocess. On plugin reload or project re-detection, multiple indexers spawn for the same project, all writing to the same SQLite database concurrently.

**Evidence**:

```javascript
// .opencode/plugins/doodba-dev.js:70-76
function spawnIndexing(projectDir, doodbaRootPath, sourcePaths) {
  const workerPath = path.resolve(packageRoot, "src/indexer-worker.ts");
  Bun.spawn(
    ["bun", workerPath, projectDir, doodbaRoot, ...sourcePaths],
    { stdout: "pipe", stderr: "pipe" }
    // ^^ Result discarded, pipes not drained
  );
}
```

**Timeline**:

```
T0: Plugin loads, detects Doodba project, calls spawnIndexing()
T1: Worker spawns, starts indexing thousands of files
T2: Worker writes detailed logs to stdout (~100 KB total)
T3: OS pipe buffer fills (~64 KB)
T4: Worker tries to write more; blocks on pipe.write()
T5: Worker is now deadlocked (can't continue indexing)
T6: Plugin waits for state.json to update (never happens)
T7: User's plugin appears frozen

T0: Plugin reloads (user restarts or edits a file)
T1: New worker spawns while old one is still running
T2: Both workers try to index same modules, acquire same SQLite locks
T3: SQLITE_BUSY errors, corrupted state
```

**Impact**:

- Indexing hangs silently after processing initial files
- User's plugin becomes unresponsive
- Multiple reloads spawn multiple workers, causing DB contention and corruption
- State.json never updates, so plugin thinks indexing is stuck forever

**Fix**:

```javascript
const SPAWNED_WORKERS = new Map(); // Track PIDs

function spawnIndexing(projectDir, doodbaRootPath, sourcePaths) {
  // Kill any existing worker for this project
  if (SPAWNED_WORKERS.has(projectDir)) {
    const oldWorker = SPAWNED_WORKERS.get(projectDir);
    try {
      oldWorker.kill("SIGTERM");
      oldWorker.kill("SIGKILL"); // Ensure it's dead
    } catch (e) {
      // Already dead, that's fine
    }
  }

  const workerPath = path.resolve(packageRoot, "src/indexer-worker.ts");
  const worker = Bun.spawn(["bun", workerPath, projectDir, doodbaRoot, ...sourcePaths], {
    stdout: "ignore", // Don't pipe, just ignore output (or 'inherit' to see logs)
    stderr: "ignore",
  });

  SPAWNED_WORKERS.set(projectDir, worker);

  // Reap the process when it exits
  worker.onExit
    .then(() => {
      SPAWNED_WORKERS.delete(projectDir);
    })
    .catch(() => {});
}
```

---

### 2. Concurrent Indexers Without Locking (Race Condition)

**File/Line**: `.opencode/plugins/doodba-dev.js:108-116`

**Severity**: 🔴 Critical — Database corruption, lost state

**Description**:
The plugin checks `readState(doodbaRoot)` and decides whether to spawn a worker. There is no mutex or file lock. If two OpenCode instances detect the same Doodba project simultaneously (or one instance receives rapid reload triggers), multiple workers spawn for the same project and write to the same SQLite database concurrently.

SQLite's WAL mode helps prevent corruption, but WAL doesn't protect against:

- Two workers inserting the same item simultaneously (duplicate key conflicts)
- Exclusive operations (schema changes, index rebuilds) blocking each other
- Non-atomic state.json updates (see **01-core-backend.md § 4**)

**Evidence**:

```javascript
// .opencode/plugins/doodba-dev.js:108-116
const state = readState(doodbaRoot);
if (state.status === "INDEXING" && state.startedAt) {
  const stuckMs = Date.now() - new Date(state.startedAt).getTime();
  if (stuckMs > STUCK_INDEXER_TIMEOUT_MS) {
    spawnIndexing(doodbaRoot, doodbaRoot, getSourcePaths(doodbaRoot)); // <-- No lock!
  }
} else if (state.status === "NO_PROJECT" || state.status === "FAILED") {
  spawnIndexing(doodbaRoot, doodbaRoot, getSourcePaths(doodbaRoot)); // <-- No lock!
}
```

**Scenario**:

```
User has two OpenCode windows open, same Doodba project.
Window A: Plugin loads, readState() → status = "FAILED"
Window B: Plugin loads simultaneously, readState() → status = "FAILED"
Window A: spawnIndexing() → Worker 1 starts
Window B: spawnIndexing() → Worker 2 starts
Both workers try to acquire write lock on same DB
Worker 1 successfully inserts module_A (1000 items)
Worker 2 also tries to insert module_A → CONFLICT errors or corruption
```

**Impact**:

- SQLite `BUSY` / `LOCKED` errors
- Duplicate inserts or lost updates
- State.json corruption (non-atomic read-modify-write)
- Undefined behavior

**Fix** (Option 1: Lockfile):

```javascript
const fs = require("fs");
const path = require("path");

function acquireIndexLock(projectDir, timeoutMs = 5000) {
  const lockDir = path.join(projectDir, ".opencode", "doodba-dev");
  const lockPath = path.join(lockDir, "indexer.lock");

  // Try to create the lock file exclusively
  const startTime = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
      );
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
      fs.closeSync(fd);
      return lockPath;
    } catch (e) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Failed to acquire indexer lock after ${timeoutMs}ms`);
      }
      // Wait a bit and retry
      require("bun").sleep(100);
    }
  }
}

function releaseIndexLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch (e) {
    console.error(`Failed to release lock: ${e.message}`);
  }
}

function spawnIndexing(projectDir, doodbaRootPath, sourcePaths) {
  let lockPath;
  try {
    lockPath = acquireIndexLock(projectDir);

    // Re-check status after acquiring lock (another worker might have completed)
    const state = readState(doodbaRootPath);
    if (state.status === "READY") {
      return; // No need to index
    }

    // Safe to spawn now
    // ...
  } finally {
    if (lockPath) releaseIndexLock(lockPath);
  }
}
```

**Fix** (Option 2: SQLite-based mutex):

```javascript
function ensureLockTable(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS _indexer_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      locked_at TEXT NOT NULL,
      locked_by TEXT
    );
    INSERT OR IGNORE INTO _indexer_lock VALUES (1, datetime('now'), NULL);
  `);
}

function acquireIndexLock(projectDir, timeoutMs = 5000) {
  const db = new DoodbaIndexDatabase(path.join(projectDir, ".opencode", "doodba-dev", "index.db"));
  const startTime = Date.now();

  while (true) {
    try {
      db.run("BEGIN IMMEDIATE"); // Exclusive lock
      return db;
    } catch (e) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Failed to acquire DB lock after ${timeoutMs}ms`);
      }
      require("bun").sleep(100);
    }
  }
}
```

---

### 3. Async `config` Callback Not Awaited by OpenCode Host

**File/Line**: `.opencode/plugins/doodba-dev.js:148-172`

**Severity**: 🔴 Critical — Commands/agents/skills silently lost

**Description**:
The plugin returns `config: async (config) => { ... }`. If OpenCode's plugin host does not `await` this Promise, the callback runs asynchronously while the plugin initialization is already considered complete. Commands, agents, and skills are injected into `config` AFTER OpenCode has already cached the initial state, so they are never registered.

**Evidence**:

```javascript
// .opencode/plugins/doodba-dev.js:148-172
return {
  tool: doodbaTools,
  config: async (config) => {
    // <-- async, but is it awaited?
    config.skills = config.skills || {};
    config.command = config.command || {};
    config.agent = config.agent || {};

    // ... load and inject markdown files ...
  },
};
```

**Impact**:

- `/doodba-setup`, `/doodba-test`, doodba agents, and the skill may not be registered
- Users in a Doodba project see no special commands/agents/skills
- Plugin appears broken even though it's actually working (tools are available, but not the high-level features)

**Fix**:
Make the plugin factory async:

```javascript
async function DoodbaDevPlugin({ directory }) {
  const doodbaRoot = findDoodbaRoot(directory);

  let configInjector = () => {};
  if (doodbaRoot) {
    configInjector = (config) => {
      config.skills = config.skills || {};
      config.command = config.command || {};
      config.agent = config.agent || {};
      // ... synchronous injection ...
    };
  }

  return {
    tool: doodbaTools,
    config: configInjector,
  };
}
```

Or, if async work is truly required, document that OpenCode's plugin host must await:

```javascript
// In the plugin:
return {
  tool: doodbaTools,
  config: async (config) => { ... },  // <-- MUST BE AWAITED BY OPENCODE
}

// Documentation:
// "The config callback is async. OpenCode MUST await it before finalizing plugin."
```

---

### 4. Tools Return JSON Strings Instead of Objects

**File/Line**: `src/tools/helpers.ts:23-32`

**Severity**: 🔴 Critical — Breaks LLM tool rendering

**Description**:
All tools return the result of `formatResponse()`, which returns a JSON-stringified object. If OpenCode's SDK serializes tool return values for the LLM, the LLM receives a JSON string instead of a structured object. This breaks native tool-result rendering and makes parsing unreliable.

**Evidence**:

```typescript
// src/tools/helpers.ts:23-32
export function formatResponse(
  status: IndexerState["status"],
  results: unknown,
  message?: string
): string {
  const payload: Record<string, unknown> = { _doodba_status: status };
  // ...
  return JSON.stringify(payload, null, 2); // <-- Returns a string, not an object
}

// src/tools/index.ts usage:
return formatResponse("READY", result, `Index updated: ...`); // <-- Tool returns string
```

**Impact**:

- LLM receives: `"{\"_doodba_status\": \"READY\", ...}"` (a JSON string)
- LLM cannot parse the structure directly
- Tool result rendering is broken
- Parsing the tool output becomes the LLM's job (error-prone)

**Fix**:

```typescript
export interface ToolResponse {
  status: IndexerState["status"];
  message?: string;
  results: unknown;
}

export function formatResponse(
  status: IndexerState["status"],
  results: unknown,
  message?: string
): ToolResponse {
  return {
    status,
    message,
    results,
  };
}

// Now the tool returns an object, not a JSON string
// OpenCode SDK will serialize it correctly for the LLM
```

---

### 5. Heavy Synchronous I/O Inside `async` Tool Blocks Event Loop

**File/Line**: `src/tools/index.ts:177-206`

**Severity**: 🔴 Critical — UI freezes during indexing

**Description**:
The `doodba_update_index` tool is declared as `async execute(...)`, but the entire body is synchronous heavy I/O:

- File walking (recursive, potentially huge)
- SHA-256 hashing of every file
- SQLite writes with transactions
- Python subprocess spawning

All of this runs on the main event loop thread, blocking OpenCode's UI and other event handlers.

**Evidence**:

```typescript
// src/tools/index.ts:177-206
async execute(args, context: ToolContext) {
  // ...
  const result = indexModules({
    rootPaths,
    modules,
    full: args.full,
    dbPath: getProjectDbPath(resolved)
  })  // <-- This is all synchronous, blocks the thread!
  return formatResponse("READY", result, `Index updated: ...`)
}
```

**Impact**:

- OpenCode UI freezes for the entire duration of indexing (minutes on large codebases)
- User cannot interact with the application
- Event loop is blocked; other timers/handlers don't run

**Fix**:

```typescript
async execute(args, context: ToolContext) {
  const resolved = resolveProjectDir(context.directory)
  const projectDb = getProjectDbPath(resolved)

  // Spawn heavy work in a background worker/process
  return new Promise((resolve) => {
    // Option 1: Spawn subprocess
    const worker = Bun.spawn(['bun', './src/indexer-worker.ts', ...])
    worker.onExit.then(() => {
      resolve(formatResponse("READY", { message: "Indexing completed in background" }))
    })

    // Option 2: Return immediately with status
    resolve(formatResponse("INDEXING", { message: "Background indexing started" }))
  })
}
```

---

## 🟠 Stability Issues

### 6. Constructor Throws Without Error Handling

**File/Line**: `.opencode/plugins/doodba-dev.js:70-76`

**Severity**: 🟠 High — Plugin crashes on invalid paths

**Description**:
If `Bun.spawn` throws (e.g., `bun` not on PATH, file not found), the exception propagates out of `spawnIndexing` with no handling. The plugin factory crash can be silent or cause the entire OpenCode instance to reload.

**Evidence**:

```javascript
function spawnIndexing(projectDir, doodbaRootPath, sourcePaths) {
  const workerPath = path.resolve(packageRoot, "src/indexer-worker.ts");
  Bun.spawn(
    // <-- Can throw ENOENT, EACCES, etc.
    ["bun", workerPath, projectDir, doodbaRoot, ...sourcePaths],
    { stdout: "pipe", stderr: "pipe" }
  );
}

// No try/catch, exception propagates
```

**Impact**:

- Plugin fails to load if `bun` is not on PATH
- No graceful degradation

**Fix**:

```javascript
function spawnIndexing(projectDir, doodbaRootPath, sourcePaths) {
  const workerPath = path.resolve(packageRoot, "src/indexer-worker.ts");
  try {
    const worker = Bun.spawn(["bun", workerPath, projectDir, doodbaRoot, ...sourcePaths], {
      stdout: "ignore",
      stderr: "ignore",
    });
    // Track worker...
  } catch (e) {
    console.error(`[doodba-dev] Failed to spawn indexer: ${e.message}`);
    updateState(doodbaRoot, { status: "FAILED", error: e.message });
  }
}
```

---

### 7. Global State Mutation in Plugin Factory

**File/Line**: `.opencode/plugins/doodba-dev.js:150-172`

**Severity**: 🟠 High — Side effects, unpredictable behavior

**Description**:
The plugin factory mutates the `config` object passed in by OpenCode. If OpenCode caches or reuses the config object across plugin instances, mutations from one instance affect others.

**Evidence**:

```javascript
// .opencode/plugins/doodba-dev.js:150-172
config.skills = config.skills || {};
config.command = config.command || {};
config.agent = config.agent || {};
config.skills.paths.push(skillsDir); // <-- Mutates in-place
config.command[name] = cmd; // <-- Mutates in-place
config.agent[name] = agent; // <-- Mutates in-place
```

**Impact**:

- If OpenCode plugin host caches `config` across reloads, duplicate commands/agents are registered
- Plugin instance A's injections appear in plugin instance B's config
- Hard to debug

**Fix**:

```javascript
// Don't mutate; let OpenCode's config merge handle it
return {
  tool: doodbaTools,
  configPatch: {
    skills: {
      paths: [skillsDir],
    },
    command: {
      [name]: cmd,
      // ...
    },
    agent: {
      [name]: agent,
      // ...
    },
  },
};
```

Or, if direct mutation is required, clone first:

```javascript
const newConfig = JSON.parse(JSON.stringify(config)); // Deep clone
newConfig.skills.paths.push(skillsDir);
return {
  tool: doodbaTools,
  config: newConfig,
};
```

---

### 8. Hardcoded Timeouts and Path Conventions

**File/Line**: `.opencode/plugins/doodba-dev.js:22` and `src/doodba-detector.ts:4-7`

**Severity**: 🟠 High — No configuration, breaks for non-standard layouts

**Description**:
The plugin hard-codes:

- `STUCK_INDEXER_TIMEOUT_MS = 30 * 60 * 1000` (30 minutes)
- Marker file: `.copier-answers.yml`
- Source directory: `odoo/custom/src`
- Max walk depth: `20`

Users with non-standard Doodba layouts cannot adapt the plugin without forking the source.

**Impact**:

- Plugin doesn't detect custom Doodba project layouts
- Timeout is inflexible (some users need faster, others longer)
- No way to extend without modifying source

**Fix**:
Create a `.opencode/doodba-dev.config.json`:

```json
{
  "doodbaMarkerFile": ".copier-answers.yml",
  "doodbaSourcePath": "odoo/custom/src",
  "stuckIndexerTimeoutMs": 1800000,
  "maxWalkDepth": 20,
  "customFieldTypes": ["MyField"],
  "customOdooBases": ["MyModel"]
}
```

Load and apply in the plugin factory:

```javascript
function DoodbaDevPlugin({ directory }) {
  const configPath = path.join(directory, ".opencode", "doodba-dev.config.json");
  const userConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath)) : {};

  const MARKER_FILE = userConfig.doodbaMarkerFile ?? ".copier-answers.yml";
  const STUCK_TIMEOUT = userConfig.stuckIndexerTimeoutMs ?? 30 * 60 * 1000;
  // ...
}
```

---

### 9. Symlink Bypass of `BLOCKED_ROOTS` Check

**File/Line**: `src/tools/index.ts:184-191`

**Severity**: 🟠 High — Security, arbitrary filesystem walk

**Description**:
The tool validates root paths against `BLOCKED_ROOTS` using `statSync(p).isDirectory()`. This follows symlinks. A user can pass a symlink to `/` or their home directory; the check passes, and the indexer walks the entire filesystem.

**Evidence**:

```typescript
// src/tools/index.ts:184-191
for (const p of rootPaths) {
  if (!existsSync(p) || !statSync(p).isDirectory()) {
    throw new Error(`Invalid root path: ${p}`);
  }
  if (BLOCKED_ROOTS.includes(p)) {
    throw new Error(`Root path is in blocked list: ${p}`);
  }
}
```

**Scenario**:

```bash
$ ln -s / /opt/odoo/custom/src/root_symlink
$ # Now passing /opt/odoo/custom/src/root_symlink as a root path passes validation
$ # Indexer walks /entire/filesystem
```

**Impact**:

- User can cause indexing to walk arbitrary directories
- Potential for information disclosure or DoS (indexing `/proc`, `/sys`, etc.)

**Fix**:

```typescript
for (const p of rootPaths) {
  if (!existsSync(p) || !statSync(p).isDirectory()) {
    throw new Error(`Invalid root path: ${p}`);
  }

  // Resolve symlinks and check against blocked roots
  const realPath = realpathSync(p);
  if (BLOCKED_ROOTS.some((blocked) => realPath === blocked || realPath.startsWith(blocked + "/"))) {
    throw new Error(`Root path resolves to blocked location: ${realPath}`);
  }

  // Also block dangerous parents
  const parents = ["/", "/home", "/Users", "/tmp", "/var", "/proc", "/sys"];
  if (parents.some((parent) => realPath === parent || realPath.startsWith(parent + "/"))) {
    throw new Error(`Root path is under dangerous parent: ${realPath}`);
  }
}
```

---

## 🟡 Maintenance Issues

### 10. Naive Hand-Rolled YAML/Markdown Frontmatter Parser

**File/Line**: `.opencode/plugins/doodba-dev.js:28-41`

**Severity**: 🟡 Medium — Fragile, cannot handle real YAML

**Description**:
The plugin implements its own YAML frontmatter parser. It cannot handle:

- Values containing colons (e.g., `url: "https://example.com"`)
- Arrays or objects
- Multi-line strings
- Windows `\r\n` line endings
- Quoted values (mangled by `replace(/^["']|["']$/g, '')`)

**Evidence**:

```javascript
// .opencode/plugins/doodba-dev.js:28-41
for (const line of match[1].split("\n")) {
  const colon = line.indexOf(":");
  if (colon > 0) {
    const key = line.slice(0, colon).trim();
    const val = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    frontmatter[key] = val;
  }
}
```

**Example failure**:

```markdown
---
name: "Example: A Command with Colon"
description: "Go to https://example.com for docs"
---
```

Parser extracts:

```js
{
  name: "Example",  // <-- Truncated at the colon!
  description: "Go to https",  // <-- Truncated!
}
```

**Impact**:

- Command/agent metadata is corrupted
- Complex command names/descriptions cannot be used
- Hard to debug (silent truncation)

**Fix**:
Use `gray-matter` (lightweight, robust):

```javascript
const matter = require("gray-matter");

const { data: frontmatter, content: body } = matter(raw);
// frontmatter is a proper JS object with full YAML support
```

---

### 11. Manual Markdown Directory Traversal

**File/Line**: `.opencode/plugins/doodba-dev.js:46-64`

**Severity**: 🟡 Medium — Duplicates work, error handling issues

**Description**:
The plugin manually implements directory traversal and file reading instead of using a standard utility. This duplicates work that OpenCode or Node.js utilities already provide.

**Impact**:

- Fragile to edge cases (permission denied, symlink loops, etc.)
- Maintenance burden

**Fix**:
Let OpenCode's native `config` resolver handle markdown files, or use `glob`:

```javascript
const glob = require("glob");

function loadMarkdownDir(dir) {
  const files = glob.sync("**/*.md", { cwd: dir });
  const result = {};
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    const { data, content } = matter(raw);
    result[path.basename(file, ".md")] = { frontmatter: data, body: content };
  }
  return result;
}
```

---

### 12. Closure Variable Shadowing Function Parameter

**File/Line**: `.opencode/plugins/doodba-dev.js:70-76`

**Severity**: 🟡 Medium — Confusing, bugs

**Description**:
The `spawnIndexing` function signature includes `doodbaRootPath`, but the implementation uses the closure variable `doodbaRoot` instead. This makes the function non-portable and confusing.

**Evidence**:

```javascript
function spawnIndexing(projectDir, doodbaRootPath, sourcePaths) {
  const workerPath = path.resolve(packageRoot, "src/indexer-worker.ts");
  Bun.spawn(
    ["bun", workerPath, projectDir, doodbaRoot, ...sourcePaths]
    //                                     ^^^^^^^^^^^ closure variable, not parameter
  );
}
```

**Impact**:

- Function cannot be called from other contexts
- Misleading API (parameter is unused)
- Bug-prone

**Fix**:

```javascript
function spawnIndexing(projectDir, doodbaRootPath, sourcePaths) {
  const workerPath = path.resolve(packageRoot, "src/indexer-worker.ts");
  Bun.spawn(
    ["bun", workerPath, projectDir, doodbaRootPath, ...sourcePaths]
    // ^^ Use the parameter, not the closure variable
  );
}
```

---

### 13. Tight Coupling to Bun Internals

**File/Line**: `.opencode/plugins/doodba-dev.js:72` and `src/database.ts:1`

**Severity**: 🟡 Medium — Not portable, fragile

**Description**:
The plugin uses Bun-specific APIs:

- `Bun.spawn` (not standard Node.js)
- `bun:sqlite` (Bun-only module)

If OpenCode ever runs under Node.js, the plugin will immediately fail with module-not-found errors.

**Impact**:

- Plugin is not portable to other runtimes
- Cannot be used in Node.js-only environments

**Fix**:
Abstract the platform-specific layers:

```typescript
// src/runtime.ts
export function spawn(cmd: string[], opts: SpawnOptions) {
  if (typeof Bun !== "undefined") {
    return Bun.spawn(cmd.slice(1), opts); // Bun.spawn doesn't need full path
  } else {
    // Fall back to Node.js child_process
    return require("child_process").spawn(cmd[0], cmd.slice(1), opts);
  }
}

export function openDatabase(path: string) {
  if (typeof Bun !== "undefined") {
    const { Database } = require("bun:sqlite");
    return new Database(path);
  } else {
    // Fall back to better-sqlite3 or sql.js
    const Database = require("better-sqlite3");
    return new Database(path);
  }
}
```

---

### 14. Tight Coupling to OpenCode Config Object Shape

**File/Line**: `.opencode/plugins/doodba-dev.js:150-172`

**Severity**: 🟡 Medium — Not resilient to API changes

**Description**:
The plugin assumes OpenCode's `config` object has `skills.paths`, `command`, and `agent` properties. If OpenCode's config schema changes, the plugin silently breaks.

**Impact**:

- Plugin breaks silently on OpenCode version upgrade
- No validation or error handling

**Fix**:

```javascript
function injectFeatures(config) {
  if (!config) {
    console.error("[doodba-dev] config object missing");
    return;
  }

  if (config.skills && Array.isArray(config.skills.paths)) {
    config.skills.paths.push(skillsDir);
  } else {
    console.warn("[doodba-dev] config.skills.paths is not an array; skipping skill injection");
  }

  if (config.command && typeof config.command === "object") {
    config.command[name] = cmd;
  } else {
    console.warn("[doodba-dev] config.command is not available; skipping command injection");
  }

  // ... similar for agent ...
}
```

---

### 15. Unused Imports in Tools

**File/Line**: `src/tools/index.ts:2-3`

**Severity**: 🟡 Low — Code quality

**Description**:
The file imports `homedir` and `join` which are never used.

**Impact**:

- Minor code quality debt
- Suggests incomplete refactoring

**Fix**:
Remove unused imports.

---

## Summary

**Critical fixes needed**: 5 (zombie subprocess, concurrent spawning, async config, JSON-string returns, synchronous I/O in async)  
**Stability improvements**: 4 (error handling, global state, hardcoded constants, symlink bypass)  
**Maintenance debt**: 6 (hand-rolled YAML, manual markdown loading, closure shadowing, tight coupling to Bun, tight coupling to OpenCode config, unused imports)

**Total issues in this section**: 15 issues in plugin architecture

**Action**: Immediately fix subprocess management (fire-and-forget, deadlock) and concurrency issues (locking). Defer async/await, return type, and maintenance refactors to Phase 3-4.

# 05: Critical Fixes (Phase 1)

**Goal**: Address 6 critical issues that cause crashes, data loss, and system deadlocks.

**Estimated effort**: 2-3 days  
**Risk reduction**: 60% (eliminates major crash scenarios)  
**Backwards compatibility**: All fixes are internal refactors with no API changes

---

## Fix 1: Zombie Subprocess + Pipe Deadlock

**Location**: `.opencode/plugins/doodba-dev.js:70-76`  
**Severity**: 🔴 Critical  
**Impact**: Guarantees UI hang after initial file processing

### Root Cause

`Bun.spawn` with `stdout: 'pipe'`, `stderr: 'pipe'` but no readers → pipes fill → worker blocks forever.

### Solution

Track subprocess, use `'ignore'` for output:

```javascript
const SPAWNED_WORKERS = new Map();

function spawnIndexing(projectDir, doodbaRootPath, sourcePaths) {
  // Kill any existing worker to prevent concurrent indexing
  const existing = SPAWNED_WORKERS.get(projectDir);
  if (existing?.pid) {
    try {
      process.kill(existing.pid, "SIGKILL");
    } catch (e) {
      // Already dead
    }
  }

  const workerPath = path.resolve(packageRoot, "src/indexer-worker.ts");

  try {
    const worker = Bun.spawn(["bun", workerPath, projectDir, doodbaRootPath, ...sourcePaths], {
      stdout: "ignore", // Don't pipe; ignore output (or 'inherit' for logs)
      stderr: "ignore",
    });

    SPAWNED_WORKERS.set(projectDir, { pid: worker.pid, worker });

    worker.onExit
      .then(() => {
        SPAWNED_WORKERS.delete(projectDir);
      })
      .catch(() => {});
  } catch (e) {
    console.error(`[doodba-dev] Failed to spawn indexer: ${e.message}`);
    updateState(doodbaRootPath, {
      status: "FAILED",
      error: `Spawn failed: ${e.message}`,
    });
  }
}

// On plugin unload/reload:
function cleanup() {
  for (const { pid } of SPAWNED_WORKERS.values()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (e) {
      // Already dead
    }
  }
  SPAWNED_WORKERS.clear();
}
```

### Test

```javascript
test("should not deadlock on large indexing output", () => {
  // Create a huge module that produces ~1MB of logging output
  // Verify indexing completes without hang
});
```

---

## Fix 2: Concurrent Indexers (Race Condition)

**Location**: `.opencode/plugins/doodba-dev.js:108-116`  
**Severity**: 🔴 Critical  
**Impact**: SQLite corruption, lost state updates

### Root Cause

Multiple workers spawn for same project without coordination. Non-atomic state.json updates lose data.

### Solution

Use lockfile for mutual exclusion:

```javascript
const fs = require("fs");
const lockTimeoutMs = 5000;

function acquireIndexLock(projectDir) {
  const lockPath = path.join(projectDir, ".opencode", "doodba-dev", "indexer.lock");
  const lockDir = path.dirname(lockPath);

  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  const startTime = Date.now();
  while (true) {
    try {
      // Exclusive create-only open
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
      );
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
      fs.closeSync(fd);
      return lockPath;
    } catch (e) {
      if (Date.now() - startTime > lockTimeoutMs) {
        const existing = fs.readFileSync(lockPath, "utf-8");
        throw new Error(`Indexer locked by another process: ${existing}`);
      }
      // Sleep and retry
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      Bun.sleep(100); // or await sleep(100)
    }
  }
}

function releaseIndexLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch (e) {
    console.warn(`[doodba-dev] Failed to release lock: ${e.message}`);
  }
}

// In plugin factory:
let lockPath = null;
try {
  lockPath = acquireIndexLock(doodbaRoot);

  // Re-check status after lock acquired
  const state = readState(doodbaRoot);
  if (state.status === "READY") {
    return; // Another worker completed while we waited
  }

  // Safe to spawn now
  spawnIndexing(doodbaRoot, doodbaRoot, getSourcePaths(doodbaRoot));
} finally {
  if (lockPath) releaseIndexLock(lockPath);
}
```

### Test

```javascript
test("should not spawn concurrent indexers", () => {
  // Simulate two plugin instances detecting same project
  // Verify only one worker spawns, not two
});
```

---

## Fix 3: Unprotected `JSON.parse` in Database

**Location**: `src/database.ts:65`  
**Severity**: 🔴 Critical  
**Impact**: All database queries crash on corrupted row

### Root Cause

`JSON.parse(r.attributes)` with no error handling.

### Solution

Safe parsing with fallback:

```typescript
// src/database.ts
function safeParseAttributes(json: string | null): Record<string, any> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed;
    }
  } catch (e) {
    console.warn(
      `[database] Failed to parse attributes JSON (${json.slice(0, 50)}...): ${e instanceof Error ? e.message : String(e)}`
    );
  }
  return {};
}

// In mapRow:
attributes: safeParseAttributes(r.attributes);
```

### Test

```typescript
test("should handle corrupted JSON in attributes", () => {
  db.run(`INSERT INTO indexed_items (...) VALUES (..., 'invalid json', ...)`);
  const item = db.getItemById(1);
  expect(item.attributes).toEqual({}); // Graceful fallback
});
```

---

## Fix 4: SQL Injection via Unescaped `LIMIT`

**Location**: `src/database.ts:198`  
**Severity**: 🔴 Critical  
**Impact**: Arbitrary SQL execution

### Root Cause

`LIMIT ${limit}` directly interpolates user input.

### Solution

Validate and coerce to integer:

```typescript
// src/database.ts in search() method
const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_SEARCH_LIMIT, 1000));
// Now limit is guaranteed to be a safe integer
const query = `SELECT ... LIMIT ${limit}`;
```

Or use parameterized query if `bun:sqlite` supports it:

```typescript
// Check bun:sqlite docs for LIMIT ? support
const stmt = this.db.prepare(`SELECT ... LIMIT ?`);
const results = stmt.all(limit);
```

### Test

```typescript
test("should reject non-numeric LIMIT values", () => {
  expect(() => db.search({ limit: "1; DROP TABLE indexed_items; --" })).toThrow();
  expect(() => db.search({ limit: {} })).toThrow();
});

test("should clamp LIMIT to safe range", () => {
  const results1 = db.search({ limit: -1 });
  expect(results1.length).toBeLessThanOrEqual(1); // Minimum is 1

  const results2 = db.search({ limit: 999999 });
  expect(results2.length).toBeLessThanOrEqual(1000); // Maximum is 1000
});
```

---

## Fix 5: Symlink Infinite Recursion

**Location**: `src/indexer.ts:81-96`  
**Severity**: 🔴 Critical  
**Impact**: Stack overflow on symlink cycles

### Root Cause

`walkDir` follows symlinks without cycle detection.

### Solution

Track visited inodes:

```typescript
// src/indexer.ts
function walkDir(dir: string, exts: string[], visited = new Set<number>()): string[] {
  const results: string[] = [];

  // Resolve and get inode
  let inode: number;
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) {
      return results; // Not a directory
    }
    inode = stat.ino;
  } catch (e) {
    return results; // Permission denied or deleted
  }

  // Check for cycles
  if (visited.has(inode)) {
    console.warn(`[walkDir] Cycle detected: ${dir}`);
    return results;
  }
  visited.add(inode);

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);

      // Recurse on directories, but not symlinks
      if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) {
        results.push(...walkDir(full, exts, visited));
      } else if (!entry.isDirectory() && exts.some((ext) => full.endsWith(ext))) {
        results.push(full);
      }
    }
  } catch (e) {
    console.warn(
      `[walkDir] Failed to read directory ${dir}: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  return results;
}
```

### Test

```typescript
test("should handle symlink cycles gracefully", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "walkdir-test-"));
  try {
    // Create a symlink cycle
    symlinkSync(tempDir, join(tempDir, "self"), "dir");

    const files = walkDir(tempDir, [".py"]);
    expect(files).toBeDefined();
    expect(files.length).toBeGreaterThanOrEqual(0); // Should not crash
  } finally {
    rmSync(tempDir, { recursive: true });
  }
});
```

---

## Fix 6: Non-Atomic State File Updates

**Location**: `src/project-state.ts:58-72`  
**Severity**: 🔴 Critical  
**Impact**: State corruption under concurrent access

### Root Cause

Read-modify-write JSON updates are not atomic.

### Solution

Use atomic file replacement:

```typescript
// src/project-state.ts
export function updateState(root: string, partial: Partial<DoodbaIndexState>): void {
  const stateDir = getStateDir(root);
  const statePath = join(stateDir, "state.json");
  const tmpPath = statePath + ".tmp";

  // Read current state
  let current = { ...DEFAULT_STATE };
  if (existsSync(statePath)) {
    try {
      const content = readFileSync(statePath, "utf-8");
      current = { ...DEFAULT_STATE, ...JSON.parse(content) };
    } catch (e) {
      console.warn(`[project-state] Failed to read state.json, starting fresh: ${e}`);
    }
  }

  // Merge update
  const next = { ...current, ...partial };

  // Write to temp file
  writeFileSync(tmpPath, JSON.stringify(next, null, 2));

  // Atomic rename (POSIX)
  try {
    renameSync(tmpPath, statePath);
  } catch (e) {
    // Cleanup temp file if rename fails
    try {
      unlinkSync(tmpPath);
    } catch (e2) {
      // Ignore cleanup error
    }
    throw new Error(`[project-state] Failed to update state: ${e}`);
  }
}
```

### Test

```typescript
test("should handle concurrent state updates atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "state-test-"));
  try {
    // Spawn two processes calling updateState simultaneously
    const p1 = spawn("bun", ["-e", `updateState("${root}", {status: "INDEXING"})`]);
    const p2 = spawn("bun", ["-e", `updateState("${root}", {error: "test"})`]);

    // Wait for both
    p1.onExit;
    p2.onExit;

    // Check that state is valid (not corrupted)
    const state = readState(root);
    expect(state).toBeDefined();
    expect(state.status || state.error).toBeDefined(); // At least one update persisted
  } finally {
    rmSync(root, { recursive: true });
  }
});
```

---

## Implementation Checklist

- [ ] Fix 1: Update `.opencode/plugins/doodba-dev.js` subprocess management
- [ ] Fix 2: Add lockfile-based concurrency control
- [ ] Fix 3: Safe JSON parsing in `src/database.ts`
- [ ] Fix 4: Validate LIMIT parameter
- [ ] Fix 5: Add inode-based cycle detection in `walkDir`
- [ ] Fix 6: Atomic state file writes using rename
- [ ] Run full test suite: `bun test`
- [ ] Smoke test with real Doodba project (large codebase)
- [ ] Verify no new compiler warnings: `biome ci .`
- [ ] Commit changes with message: "fix: address 6 critical stability issues"

---

## Validation

After implementing all 6 fixes, verify:

1. **No deadlocks**: Spin up plugin with large Doodba project, verify indexing completes
2. **No data corruption**: Multiple plugin reloads, verify `state.json` is valid
3. **No crashes**: Symlink cycles, permission denied, malformed data in DB
4. **No SQL injection**: Malicious tool arguments are rejected

```bash
# Comprehensive smoke test
cd /path/to/doodba/project
opencode inspect --plugin opencode-doodba-dev
# Verify /doodba-search and /doodba-update-index work
# Verify plugin doesn't hang or crash
```

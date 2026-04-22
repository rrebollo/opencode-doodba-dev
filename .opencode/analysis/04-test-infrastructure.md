# 04: Test Infrastructure Analysis

**Context**: This section covers the test suite architecture, test isolation, CI/CD setup, and configuration quality.

**Files analyzed**:

- `package.json` (root)
- `tsconfig.json`
- `biome.json`
- `.opencode/package.json`
- `tests/setup.ts` (missing)
- `tests/unit/*.test.ts` (4 files)
- `tests/e2e/*.test.ts` (14 files)
- `tests/e2e/fixtures/res_partner_category.py`
- `README.md`
- `docs/TESTING.md`

---

## Tech Stack

- **Test runner**: Bun test runner (built-in)
- **Test framework**: Bun.test + expect/assert (native)
- **Linting/Formatting**: Biome 2.4.12
- **TypeScript**: 5.5+ (strict mode, no emit)
- **CI/CD**: None configured
- **Coverage**: No tooling
- **Pre-commit hooks**: None
- **Package manager**: Bun (root), npm (`.opencode/` subdir)

---

## 🔴 Critical Issues

### 1. Shared Mutable Temp Database Across Parallel Tests

**File/Line**: `tests/unit/database.test.ts:7`

**Severity**: 🔴 Critical — Race conditions, test failures

**Description**:
The `TMP_DB` path is generated once at module load time using `Date.now()`. If Bun executes tests in parallel (multiple test files running simultaneously, or multiple test cases in the same file), all tests share the exact same temporary database file. One test's `afterEach` cleanup (`unlinkSync(TMP_DB)`) deletes the DB while another test is actively using it, causing `SQLITE_CANTOPEN` or `SQLITE_NOTADB` errors.

**Evidence**:

```typescript
// tests/unit/database.test.ts:7
const TMP_DB = join(tmpdir(), `test-database-${Date.now()}.db`);

// ... then in test bodies:
beforeEach(() => {
  // TMP_DB exists and is shared across all tests in this file
  db = new DoodbaIndexDatabase(TMP_DB);
});

afterEach(() => {
  db.close();
  unlinkSync(TMP_DB); // <-- If another test is using TMP_DB, this crashes it!
});
```

**Timeline**:

```
Test 1: opens TMP_DB
Test 2: opens same TMP_DB (parallel execution)
Test 1: afterEach → unlinkSync(TMP_DB)
Test 2: tries to access TMP_DB → SQLITE_CANTOPEN
```

**Impact**:

- Tests fail intermittently when run in parallel
- CI becomes flaky
- Hard to debug (failures don't reproduce consistently)

**Fix**:

```typescript
let TMP_DB: string;

beforeEach(() => {
  TMP_DB = join(tmpdir(), `test-database-${crypto.randomBytes(8).toString("hex")}.db`);
  db = new DoodbaIndexDatabase(TMP_DB);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TMP_DB);
  } catch (e) {
    // File may already be deleted or in use; don't crash the test
    console.warn(`Failed to clean up ${TMP_DB}: ${e.message}`);
  }
});
```

---

### 2. Shared Mutable Temp Directory Across Parallel Tests

**File/Line**: `tests/unit/doodba-detector.test.ts:7`

**Severity**: 🔴 Critical — Race conditions, data corruption

**Description**:
Similar to the database issue. `TMP` is created once at module load time. Tests call `setup()`/`teardown()` manually inside test bodies instead of using `beforeEach`/`afterEach`. If tests run in parallel, one test's `teardown()` deletes the directory while another test is writing to it.

**Evidence**:

```typescript
// tests/unit/doodba-detector.test.ts:7
const TMP = join(tmpdir(), `doodba-detector-test-${Date.now()}`);

// Then in tests:
test("should find root", async () => {
  setup();
  try {
    const result = findDoodbaRoot(TMP);
    expect(result).toBe(TMP);
  } finally {
    teardown(); // <-- No isolation from other tests!
  }
});
```

**Impact**:

- Tests interfere with each other
- Race conditions on `rmSync`
- Orphaned temp directories if tests fail

**Fix**:

```typescript
beforeEach(() => {
  TMP = join(tmpdir(), `doodba-detector-test-${crypto.randomUUID()}`);
  setup();
});

afterEach(() => {
  try {
    teardown();
  } catch (e) {
    console.warn(`Failed to clean up ${TMP}`);
  }
});

test("should find root", async () => {
  const result = findDoodbaRoot(TMP);
  expect(result).toBe(TMP);
});
```

---

### 3. Flaky Timing Assertions (< 100ms)

**File/Line**: `tests/e2e/plugin-integration.test.ts:163, 188`

**Severity**: 🔴 Critical — Intermittent CI failures

**Description**:
Tests assert that operations complete in less than 100 milliseconds. This is a non-deterministic assertion that fails under CPU load, CI throttling, antivirus scanning, or on slower hardware.

**Evidence**:

```typescript
// tests/e2e/plugin-integration.test.ts:163
expect(callDuration).toBeLessThan(100);

// tests/e2e/plugin-integration.test.ts:188
expect(elapsed).toBeLessThan(100);
```

**Scenario**:

```
Local machine: Test passes (fast CPU)
CI with resource limits: Test fails (slow or throttled)
Developer's laptop with antivirus: Test fails
Test fails randomly depending on system load
```

**Impact**:

- CI is unreliable
- Tests fail on slower hardware even if the code is correct
- Developer frustration with flaky tests

**Fix**:
Replace timing assertions with deterministic assertions:

```typescript
// Instead of:
// expect(callDuration).toBeLessThan(100)

// Test that the result is correct, not that it's fast:
const result = await DoodbaDevPlugin({ directory: asyncSubdir });
expect(result.tool).toBeDefined();
expect(result.tool.doodba_search).toBeDefined();
expect(result.config || !asyncSubdir.includes("doodba")).toBe(true);

// If performance testing is needed, measure but don't fail:
if (callDuration > 100) {
  console.warn(`Warning: Plugin initialization took ${callDuration}ms (expected < 100ms)`);
}
```

---

### 4. Global Process State Mutation Without Guaranteed Restoration

**File/Line**: `tests/e2e/queries.test.ts:129-148`

**Severity**: 🔴 Critical — Affects all subsequent tests

**Description**:
The test changes the process working directory via `chdir(tmpdir())`. While wrapped in `try/finally`, if the test receives SIGTERM, is interrupted, or the `finally` block throws, the process remains in `/tmp`. All subsequent tests run from the wrong directory.

**Evidence**:

```typescript
// tests/e2e/queries.test.ts:129-148
const originalCwd = process.cwd();
try {
  chdir(tmpdir());
  // ... test logic ...
} finally {
  chdir(originalCwd);
}
```

**Scenario**:

```
Test 1: calls chdir(tmpdir())
Test 1: throws an unexpected error in the finally block
Test 1: originalCwd restoration is skipped
Test 2 onwards: run from /tmp instead of project root
Test 2: looks for src/ → expects process.cwd() + "src/"
Test 2: searches in /tmp/src/ → ENOENT
```

**Impact**:

- One failing test breaks all subsequent tests
- Hard to debug (the error manifests in unrelated tests)

**Fix**:
Use a more robust pattern:

```typescript
let restoredCwd = false;
const originalCwd = process.cwd();
try {
  chdir(tmpdir());
  // ... test logic ...
  chdir(originalCwd);
  restoredCwd = true;
} finally {
  if (!restoredCwd) {
    try {
      chdir(originalCwd);
    } catch (e) {
      console.error(`CRITICAL: Failed to restore cwd to ${originalCwd}: ${e.message}`);
      // Can't recover; all subsequent tests are broken
    }
  }
}
```

Or use a test harness that validates cwd state:

```typescript
afterEach(() => {
  const finalCwd = process.cwd();
  if (finalCwd !== PROJECT_ROOT) {
    throw new Error(`Test left process.cwd() in ${finalCwd}, expected ${PROJECT_ROOT}`);
  }
});
```

---

### 5. Orphaned Temp Directory on Assertion Failure

**File/Line**: `tests/e2e/detection.test.ts:28-31`

**Severity**: 🔴 Critical — Temp dir leak

**Description**:
The test creates a temp directory, performs assertions, then cleans up at the end. If an assertion throws, the cleanup is skipped and the temp directory is left behind in `/tmp`.

**Evidence**:

```typescript
// tests/e2e/detection.test.ts:28-31
const orphanDir = mkdtempSync(join(tmpdir(), "doodba-orphan-"));
const result = findDoodbaRoot(orphanDir);
expect(result).toBeNull();
rmSync(orphanDir, { recursive: true }); // <-- If expect() throws, this never runs
```

**Impact**:

- Temp directories accumulate in `/tmp` over time
- CI disk space fills up
- Orphaned dirs are hard to clean up

**Fix**:

```typescript
const orphanDir = mkdtempSync(join(tmpdir(), "doodba-orphan-"));
try {
  const result = findDoodbaRoot(orphanDir);
  expect(result).toBeNull();
} finally {
  try {
    rmSync(orphanDir, { recursive: true });
  } catch (e) {
    console.warn(`Failed to clean up ${orphanDir}`);
  }
}
```

Or use `beforeEach`/`afterEach`:

```typescript
let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "doodba-test-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("should return null for orphan", () => {
  const result = findDoodbaRoot(tempDir);
  expect(result).toBeNull();
});
```

---

### 6. Broken Console Spy Isolation

**File/Line**: `tests/e2e/cycle-detection.test.ts:33-48`

**Severity**: 🔴 Critical — Affects subsequent tests

**Description**:
A `spyOn(console, "warn")` is installed inside the test but only restored at the end of the test body. If the test throws an exception before `mockRestore()`, the spy remains active for all subsequent tests, breaking them.

**Evidence**:

```typescript
// tests/e2e/cycle-detection.test.ts:33-48
const spy = spyOn(console, "warn").mockImplementation((...args) => {
  warnings.push(args)
})

// If indexModules() throws here, the spy is never restored!
const result = await indexModules({ ... })

spy.mockRestore()  // <-- Skipped on exception
```

**Impact**:

- One failing test leaves console.warn mocked for all subsequent tests
- Hard to debug
- Test output is corrupted by previous test's mock

**Fix**:

```typescript
beforeEach(() => {
  // Install spy
})

afterEach(() => {
  // Restore spy (always runs, even on exception)
})

test("should collect warnings", async () => {
  const warnings: any[] = []
  spyOn(console, "warn").mockImplementation((...args) => {
    warnings.push(args)
  })

  const result = await indexModules({ ... })
  expect(warnings.length).toBeGreaterThan(0)
})
```

---

## 🟠 Stability Issues

### 7. Dynamic Module Imports May Cache State

**File/Line**: `tests/e2e/plugin-integration.test.ts:55-57`

**Severity**: 🟠 High — Test pollution

**Description**:
Tests dynamically import `../../.opencode/plugins/doodba-dev.js` with `import()`. Bun's module cache may return the same module instance across tests. Side effects or global state from one test leak into the next.

**Evidence**:

```typescript
// tests/e2e/plugin-integration.test.ts:55-57
const { DoodbaDevPlugin } = await import("../../.opencode/plugins/doodba-dev.js");
// Bun's module cache returns the same instance if imported again
```

**Impact**:

- Global state in the plugin persists across tests
- Tests can pass/fail based on execution order

**Fix**:

```typescript
// Option 1: Force module reload
const { DoodbaDevPlugin } = await import(`../../.opencode/plugins/doodba-dev.js?t=${Date.now()}`);

// Option 2: Isolate plugin in a subprocess (more robust)
// Spawn worker to load plugin, return result
```

---

### 8. Tests Spawn Real Background Processes Without Cleanup

**File/Line**: `tests/e2e/plugin-integration.test.ts:144-169, 171-192`

**Severity**: 🟠 High — Zombie processes, resource leak

**Description**:
Tests call `DoodbaDevPlugin` which may spawn background indexer processes. Tests assert fast completion time but never wait for, track, or kill the spawned processes. If tests run in parallel, multiple indexers are spawned simultaneously.

**Evidence**:

```typescript
// tests/e2e/plugin-integration.test.ts
const result = await DoodbaDevPlugin({ directory: asyncSubdir });
// Plugin might have spawned Bun.spawn(...) in the background
// Test doesn't wait for it or track it
expect(callDuration).toBeLessThan(100); // <-- Returns immediately, ignoring spawned processes
```

**Impact**:

- Spawned workers accumulate
- Database contention (multiple workers writing to same DB)
- Resource exhaustion in CI

**Fix**:

```typescript
// Option 1: Mock Bun.spawn
beforeEach(() => {
  spyOn(global, "Bun").and.returnValue({
    spawn: () => ({ onExit: Promise.resolve() }),
  });
});

// Option 2: Track and kill spawned processes
const spawnedProcesses = new Set();
const originalSpawn = Bun.spawn.bind(Bun);
Bun.spawn = (...args) => {
  const proc = originalSpawn(...args);
  spawnedProcesses.add(proc);
  return proc;
};

afterEach(() => {
  for (const proc of spawnedProcesses) {
    try {
      proc.kill("SIGKILL");
    } catch (e) {
      // Already dead
    }
  }
  spawnedProcesses.clear();
});
```

---

### 9. Database State Leaks Between Tests

**File/Line**: `tests/e2e/indexing-workflow.test.ts:17-28, 30-54`

**Severity**: 🟠 High — Tests not independent

**Description**:
The `beforeAll` creates a fixture database. Tests call `indexModules({ full: true, ... })` which should clear and re-index. However, if a bug causes `full: true` to not actually clear, subsequent tests see polluted data.

**Impact**:

- Tests not truly independent
- Pollution can mask bugs
- Flaky tests (depends on execution order)

**Fix**:

```typescript
beforeEach(() => {
  // Create fresh database for each test
  // Or: explicitly clear before each test
  db.run("DELETE FROM indexed_items");
  db.run("DELETE FROM item_references");
});

afterEach(() => {
  db.close();
});
```

---

### 10. Missing Test Timeouts

**File/Line**: `bunfig.toml` (missing)

**Severity**: 🟠 High — Tests can hang indefinitely

**Description**:
There is no `bunfig.toml` with test timeout configuration. If a test hangs (infinite loop, deadlock), it can block CI for hours.

**Impact**:

- CI can hang indefinitely
- Hard to debug hang issues

**Fix**:
Create `bunfig.toml`:

```toml
[test]
timeout = 30000  # 30 seconds per test
preload = ["./tests/setup.ts"]
```

---

## 🟡 Maintenance Issues

### 11. No Centralized Test Setup File

**File/Line**: `tests/setup.ts` (missing)

**Severity**: 🟡 Medium — Duplicated setup, hard to maintain

**Description**:
There is no `tests/setup.ts`. Global setup (mocks, matchers, fixtures) is duplicated across multiple test files or missing entirely.

**Impact**:

- Duplicated setup code
- Hard to maintain
- New tests don't know where to hook in

**Fix**:
Create `tests/setup.ts`:

```typescript
import { beforeEach, afterEach, describe } from 'bun:test'

// Global setup
beforeEach(() => {
  // Reset global state
  process.cwd = jest.fn(...)  // Mock cwd if needed
})

afterEach(() => {
  // Validate test isolation
  const finalCwd = process.cwd()
  if (finalCwd !== PROJECT_ROOT) {
    throw new Error(`Test left process in ${finalCwd}`)
  }
})

// Custom matchers
expect.extend({
  toBeValidModule(received) {
    // ...
  },
})
```

Then reference in `bunfig.toml`:

```toml
[test]
preload = ["./tests/setup.ts"]
```

---

### 12. Fixture Code Duplicated

**File/Line**: `tests/e2e/setup.ts:202-223` vs `tests/e2e/fixtures/res_partner_category.py`

**Severity**: 🟡 Medium — Duplication, maintenance burden

**Description**:
The Python fixture code `res_partner_category.py` is defined in two places:

1. `tests/e2e/fixtures/res_partner_category.py` (the actual file)
2. `tests/e2e/setup.ts:202-223` (inline string)

Any change must be made in both places.

**Evidence**:

```typescript
// tests/e2e/setup.ts:202-223
const pythonCode = `
class ResPartnerCategory(models.Model):
    _name = 'res.partner.category'
    ...
`

// And in tests/e2e/fixtures/res_partner_category.py
class ResPartnerCategory(models.Model):
    _name = 'res.partner.category'
    ...
```

**Impact**:

- Duplicated fixture increases maintenance burden
- Easy to forget to update both places

**Fix**:

```typescript
// tests/e2e/setup.ts
const pythonCode = readFileSync(
  path.join(__dirname, "fixtures", "res_partner_category.py"),
  "utf-8"
);
```

---

### 13. Missing Individual Test Suite Scripts

**File/Line**: `package.json`

**Severity**: 🟡 Medium — Difficult to run specific tests

**Description**:
The `package.json` only has `"test": "bun test"`. Developers must know the directory structure to run specific suites.

**Evidence**:

```json
{
  "scripts": {
    "test": "bun test"
  }
}
```

**Impact**:

- Can't easily run `npm test:unit` or `npm test:e2e`
- New developers don't know how to run tests
- CI must run all tests, can't parallelize by type

**Fix**:

```json
{
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test tests/unit",
    "test:e2e": "bun test tests/e2e",
    "test:watch": "bun test --watch"
  }
}
```

---

### 14. No Test Coverage Reporting

**File/Line**: `package.json`

**Severity**: 🟡 Medium — Can't measure coverage

**Description**:
There is no coverage configuration or reporting. No way to measure which code paths are exercised by tests.

**Impact**:

- Can't identify untested code
- Can't enforce coverage targets

**Fix**:

```bash
# Use Bun's built-in coverage
bun test --coverage

# Or configure in bunfig.toml:
[test]
coverage = true
coverageFormats = ["html", "text"]
```

---

### 15. Missing package.json Metadata

**File/Line**: `package.json`

**Severity**: 🟡 Medium — Package discoverability

**Description**:
Missing `files`, `exports`, `types`, `repository`, `bugs`, `homepage`, and `keywords` fields.

**Evidence**:

```json
{
  "name": "opencode-doodba-dev",
  "main": ".opencode/plugins/doodba-dev.js",
  "type": "module"
  // Missing: files, exports, types, repository, bugs, homepage, keywords
}
```

**Impact**:

- Package publishes tests, docs, and source code to npm
- No TypeScript declaration entry point
- Package is hard to discover

**Fix**:

```json
{
  "name": "opencode-doodba-dev",
  "version": "0.1.0",
  "description": "...",
  "type": "module",
  "main": ".opencode/plugins/doodba-dev.js",
  "types": ".opencode/plugins/doodba-dev.d.ts",
  "exports": {
    ".": ".opencode/plugins/doodba-dev.js"
  },
  "files": [
    ".opencode/plugins/doodba-dev.js",
    ".opencode/commands/",
    ".opencode/agents/",
    ".opencode/skills/",
    ".opencode/package.json",
    "src/"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/..."
  },
  "bugs": {
    "url": "https://github.com/.../issues"
  },
  "homepage": "https://github.com/...",
  "keywords": ["opencode", "odoo", "doodba", "indexing"]
}
```

---

### 16. Biome Configuration Missing File Exclusions

**File/Line**: `biome.json`

**Severity**: 🟡 Medium — Lints irrelevant files

**Description**:
No `files.include` or `files.ignore` in `biome.json`. Biome attempts to format/lint everything including `.opencode/`, `bun.lock`, and build artifacts.

**Evidence**:

```json
{
  "javascript": { ... },
  "linter": { ... },
  "formatter": { ... }
  // Missing: files configuration
}
```

**Impact**:

- Biome is slow (lints lock files, node_modules, etc.)
- Configuration is unclear

**Fix**:

```json
{
  "files": {
    "include": ["src/", "tests/", ".opencode/"],
    "ignore": [
      "node_modules/",
      ".git/",
      "bun.lock",
      ".opencode/node_modules/",
      ".opencode/package-lock.json"
    ]
  },
  "vcs": {
    "useIgnoreFile": true
  },
  "javascript": { ... },
  "linter": { ... },
  "formatter": { ... }
}
```

---

### 17. tsconfig.json Missing Recommended Strictness

**File/Line**: `tsconfig.json`

**Severity**: 🟡 Medium — Type safety gaps

**Description**:
Missing `esModuleInterop`, `forceConsistentCasingInFileNames`, `resolveJsonModule`, `lib`, `rootDir`, `baseUrl`.

**Evidence**:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  }
}
```

**Impact**:

- Module resolution ambiguity
- Case sensitivity issues on Windows
- JSON import not validated

**Fix**:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun-types"],
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "rootDir": ".",
    "baseUrl": ".",
    "lib": ["ES2022"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", ".opencode/**/*.js"],
  "exclude": ["node_modules", ".opencode/node_modules"]
}
```

---

### 18. Incomplete Parser Test Coverage

**File/Line**: `tests/unit/parsers.test.ts`

**Severity**: 🟡 Medium — Missing critical tests

**Description**:
Only tests three utility functions (`qualifyXmlId`, `lineNumberAt`, `toArray`). Zero unit tests for actual parsers: `parsePythonAst`, `parseXml`, `parseCsv`, `parseManifest`.

**Evidence**:

```typescript
// tests/unit/parsers.test.ts: 42 lines total
// Only tests:
describe("qualifyXmlId", () => { ... })
describe("lineNumberAt", () => { ... })
describe("toArray", () => { ... })
// Missing: parsePythonAst, parseXml, parseCsv, parseManifest
```

**Impact**:

- Parser bugs go undetected
- No regression protection
- Hard to debug parser failures

**Fix**:
Add comprehensive parser tests:

```typescript
describe("parsePythonAst", () => {
  test("extracts models from Python files", () => { ... })
  test("handles malformed Python gracefully", () => { ... })
  test("extracts field types", () => { ... })
  test("skips large files", () => { ... })
})

describe("parseXml", () => {
  test("extracts records from XML", () => { ... })
  test("handles XXE gracefully", () => { ... })
  test("reports correct line numbers", () => { ... })
})

describe("parseCsv", () => {
  test("parses valid CSV", () => { ... })
  test("rejects unclosed quotes", () => { ... })
})

describe("parseManifest", () => {
  test("extracts manifest fields", () => { ... })
  test("handles escaped quotes", () => { ... })
  test("handles colons in values", () => { ... })
})
```

---

### 19. Database Unit Tests Missing Edge Cases

**File/Line**: `tests/unit/database.test.ts`

**Severity**: 🟡 Medium — Incomplete coverage

**Description**:
Tests basic database operations but miss critical edge cases:

- Calling `close()` twice
- SQL injection in search queries
- Concurrent database access
- Missing database file
- Extremely large result sets

**Impact**:

- Edge case bugs slip through
- No regression protection

**Fix**:
Add edge case tests:

```typescript
test("close() called twice should not crash", () => {
  db.close();
  expect(() => db.close()).not.toThrow();
});

test("search with malicious limit should not execute SQL", () => {
  expect(() => db.search({ limit: "1; DROP TABLE indexed_items; --" })).toThrow();
});

test("concurrent access should not corrupt data", async () => {
  // Spawn two processes accessing same DB
  // Verify data consistency
});
```

---

## Summary

**Critical fixes needed**: 6 (shared temp DB, shared temp dir, timing assertions, cwd mutation, orphan dirs, spy isolation)  
**Stability improvements**: 4 (module caching, spawned processes, DB state leaks, missing timeouts)  
**Maintenance debt**: 9 (no setup.ts, duplicated fixtures, missing test scripts, no coverage, incomplete package.json, biome config, tsconfig, incomplete parser tests, database edge cases)

**Total issues in this section**: 19 issues in test infrastructure

**Action**: Immediately fix test isolation (temp DB/dir per test, proper setup/teardown) and remove flaky timing assertions. This is blocking reliable CI.

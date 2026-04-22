# 06: Recommendations & Roadmap

**Overview**: Strategic recommendations for long-term stability, maintainability, and OpenCode SDK compliance.

---

## Phase 2: Test Infrastructure (Days 3-4)

**Goal**: Make CI reliable, catch regressions  
**Risk reduction**: 40% (prevents test-driven bugs from shipping)

### 2.1 Fix Test Isolation (CRITICAL)

**Files**: `tests/unit/database.test.ts:7`, `tests/unit/doodba-detector.test.ts:7`

Generate unique temp paths per test:

```typescript
// Before each test, not at module load time
beforeEach(() => {
  TMP_DB = join(tmpdir(), `test-database-${crypto.randomUUID()}.db`);
});

afterEach(() => {
  if (db) db.close();
  try {
    unlinkSync(TMP_DB);
  } catch (e) {
    // Ignore cleanup errors
  }
});
```

### 2.2 Remove Flaky Timing Assertions

**Files**: `tests/e2e/plugin-integration.test.ts:163, 188`

Replace `expect(duration).toBeLessThan(100)` with deterministic assertions:

```typescript
// Instead of timing checks, verify functionality
const plugin = await DoodbaDevPlugin({ directory });
expect(plugin.tool).toBeDefined();
expect(plugin.tool.doodba_search).toBeDefined();
// Don't assert performance; measure if needed but don't fail on it
```

### 2.3 Add `bunfig.toml`

```toml
[test]
preload = ["./tests/setup.ts"]
timeout = 30000
```

### 2.4 Create `tests/setup.ts`

Global test setup, shared mocks, helpers:

```typescript
import { beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = process.cwd();

// Validate test isolation
afterEach(() => {
  if (process.cwd() !== PROJECT_ROOT) {
    throw new Error(`Test left process in ${process.cwd()}, expected ${PROJECT_ROOT}`);
  }
});
```

### 2.5 Add Test Scripts to `package.json`

```json
{
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test tests/unit",
    "test:e2e": "bun test tests/e2e",
    "test:watch": "bun test --watch",
    "test:coverage": "bun test --coverage"
  }
}
```

---

## Phase 3: API Compliance & Event Loop (Days 4-5)

**Goal**: Proper OpenCode integration, no UI freezes  
**Risk reduction**: 20% (improves user experience)

### 3.1 Make Plugin `config` Synchronous

**File**: `.opencode/plugins/doodba-dev.js:148-172`

Do all heavy lifting before returning config:

```javascript
function DoodbaDevPlugin({ directory }) {
  const doodbaRoot = findDoodbaRoot(directory);

  // Synchronous config injection
  const configPatch = {};
  if (doodbaRoot) {
    configPatch.skills = { paths: [skillsDir] };
    configPatch.command = loadCommands();
    configPatch.agent = loadAgents();
  }

  return {
    tool: doodbaTools,
    config: configPatch, // Not a callback; just return the patch
  };
}
```

### 3.2 Return Plain Objects from Tools (Not JSON Strings)

**File**: `src/tools/helpers.ts:23-32`

```typescript
export interface ToolResponse {
  status: IndexerState["status"];
  message?: string;
  results?: unknown;
}

export function formatResponse(
  status: IndexerState["status"],
  results?: unknown,
  message?: string
): ToolResponse {
  return {
    status,
    message: message || getStatusMessage(status),
    results,
  };
}

// Tools now return ToolResponse, not JSON string
// OpenCode SDK serializes it correctly for LLM
```

### 3.3 Offload Heavy Indexing from Event Loop

**File**: `src/tools/index.ts:177-206`

Return immediately with status, run indexing in background:

```typescript
async execute(args, context: ToolContext) {
  const resolved = resolveProjectDir(context.directory)

  // Don't block the event loop; spawn background work
  setImmediate(() => {
    // Heavy indexing happens here, not blocking await
    indexModules({ ... })
    updateState(resolved, { status: "READY" })
  })

  return formatResponse(
    "INDEXING",
    undefined,
    "Indexing started in background"
  )
}
```

Or spawn a subprocess:

```typescript
async execute(args, context: ToolContext) {
  const resolved = resolveProjectDir(context.directory)
  const worker = spawnIndexingWorker(resolved, args)

  return new Promise((resolve) => {
    worker.onExit.then(() => {
      resolve(formatResponse("READY", { indexed: true }))
    })
  })
}
```

---

## Phase 4: Code Quality & Maintenance (Days 5-7)

**Goal**: Reduce technical debt, improve maintainability  
**Risk reduction**: 15% (easier to extend/debug)

### 4.1 Delete or Rehabilitate Dead Code

**File**: `src/parsers/python-regex.ts`

Option A: **Delete** (recommended)

```bash
rm src/parsers/python-regex.ts
grep -r "parsePythonRegex" src/ tests/ || echo "No references found"
```

Option B: **Use as fallback** (if robustness is desired)

- Fix O(n²) string slicing
- Merge types with `ParsedItem`
- Wire into indexer with try-fallback-on-error

### 4.2 Consolidate Parser Types

Merge `python-regex.ts` types with `types.ts`:

```typescript
// src/parsers/types.ts
export interface ParsedItem {
  itemType: string;
  name: string;
  parentName: string | null;
  module: string;
  attributes: Record<string, unknown>; // Use 'unknown', not 'any'
  dependencyDepth: number;
  references?: ItemReference[];
}

export interface ItemReference {
  itemId?: number;
  filePath: string;
  lineNumber: number;
  referenceType: string;
  context?: string | null;
}
```

### 4.3 Replace Hand-Rolled YAML Parser

**File**: `.opencode/plugins/doodba-dev.js:28-41`

Use `gray-matter` or `yaml` npm package:

```javascript
import matter from "gray-matter";

function parseFrontmatter(content) {
  const { data: frontmatter, content: body } = matter(content);
  return { frontmatter, body };
}
```

### 4.4 Add Configuration Surface

Create `.opencode/doodba-dev.config.json`:

```json
{
  "doodbaMarkerFile": ".copier-answers.yml",
  "doodbaSourcePath": "odoo/custom/src",
  "stuckIndexerTimeoutMs": 1800000,
  "maxWalkDepth": 20,
  "customFieldTypes": [],
  "customOdooBases": []
}
```

Load in plugin factory:

```javascript
const userConfig = loadConfig(directory);
const MARKER_FILE = userConfig?.doodbaMarkerFile ?? ".copier-answers.yml";
const STUCK_TIMEOUT = userConfig?.stuckIndexerTimeoutMs ?? 30 * 60 * 1000;
```

### 4.5 Harden Manifest Parsing

**File**: `src/parsers/manifest.ts`

Either:

1. Spawn Python to parse dict safely: `ast.literal_eval()`
2. Use a Python literal parser library

```typescript
// Option: Invoke Python for safety
function parseManifest(filePath: string, module: string): ParsedItem[] {
  const manifestCode = readFileSync(filePath, "utf-8");

  // Spawn Python to safely evaluate the dict
  const result = spawnSync(PYTHON_BINARY, [
    "-c",
    `import ast, json; d = ast.literal_eval(${JSON.stringify(manifestCode)}); print(json.dumps(d))`,
  ]);

  if (result.status !== 0) {
    console.warn(`[manifest] Failed to parse ${filePath}`);
    return [];
  }

  const manifest = JSON.parse(result.stdout);
  return extractManifestItems(manifest, module);
}
```

### 4.6 Add Comprehensive Parser Tests

Add to `tests/unit/parsers.test.ts`:

```typescript
describe("parsePythonAst", () => {
  test("extracts models and fields", () => {
    const items = parsePythonAst("tests/fixtures/model.py", "my_module");
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].itemType).toBe("model");
  });

  test("handles malformed Python gracefully", () => {
    const items = parsePythonAst("tests/fixtures/broken.py", "my_module");
    expect(items).toEqual([]); // Graceful fallback
  });

  test("skips files over 50MB", () => {
    // Create temp huge file
    // Verify it's skipped, not indexed
  });
});

describe("parseManifest", () => {
  test("extracts manifest metadata", () => {
    const items = parseManifest("tests/fixtures/__manifest__.py", "my_module");
    expect(items[0].name).toBe("My Module");
  });

  test("handles escaped quotes", () => {
    const items = parseManifest("tests/fixtures/escaped_manifest.py", "my_module");
    expect(items[0].attributes.description).toContain("'");
  });

  test("handles colons in values", () => {
    const items = parseManifest("tests/fixtures/url_manifest.py", "my_module");
    expect(items[0].attributes.url).toContain("https://");
  });
});
```

### 4.7 Add Configuration to `package.json`

```json
{
  "name": "opencode-doodba-dev",
  "version": "0.1.0",
  "description": "OpenCode plugin for Doodba (Odoo) development — provides source indexing and AI-assisted exploration",
  "type": "module",
  "main": ".opencode/plugins/doodba-dev.js",
  "files": [".opencode/", "src/"],
  "exports": {
    ".": ".opencode/plugins/doodba-dev.js"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/anomalyco/opencode-doodba-dev"
  },
  "keywords": ["opencode", "odoo", "doodba", "indexing"]
}
```

### 4.8 Update `biome.json`

```json
{
  "files": {
    "include": ["src/", "tests/", ".opencode/"],
    "ignore": ["node_modules", ".opencode/node_modules", "bun.lock"]
  },
  "vcs": {
    "useIgnoreFile": true
  }
}
```

### 4.9 Update `tsconfig.json`

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
    "lib": ["ES2022"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", ".opencode/node_modules"]
}
```

---

## Long-Term Initiatives (2+ weeks)

### Performance Optimization

1. **Batch Python AST parsing**: Instead of one process per file, use a persistent Python worker that receives file paths in a queue and outputs results. Reduces spawn overhead by ~90%.

2. **Parallel indexing**: Use Worker threads or subprocess pools to index multiple modules concurrently (with DB locking to prevent conflicts).

3. **Incremental indexing improvements**: Cache file hashes more aggressively; skip unchanged directories entirely.

### Architecture Improvements

1. **Decouple parsing from indexing**: Make parsers pure functions with clear input/output. Use a plugin system for custom parsers.

2. **Separate concerns**: Split monolithic `database.ts` into `database.ts` (schema), `query.ts` (read operations), `mutations.ts` (write operations).

3. **Plugin to SDK compliance**: Validate plugin against OpenCode's plugin SDK specification at startup; fail fast if incompatible.

### Observability

1. **Structured logging**: Replace ad-hoc console logs with structured JSON logs (timestamp, level, component, context).

2. **Metrics**: Track indexing time, file count, parse errors, DB operations.

3. **Health checks**: Expose a `/health` endpoint that verifies plugin state (is indexing stuck? is DB corrupt?).

---

## Summary Table

| Phase | Fixes                                                            | Effort   | Risk Reduction | Priority    |
| ----- | ---------------------------------------------------------------- | -------- | -------------- | ----------- |
| **1** | 6 critical (subprocess, concurrency, JSON, SQL, symlinks, state) | 2-3 days | 60%            | 🔴 CRITICAL |
| **2** | Test isolation, flaky tests, CI config                           | 1-2 days | 40%            | 🟠 HIGH     |
| **3** | API compliance, event loop, tool returns                         | 1 day    | 20%            | 🟡 MEDIUM   |
| **4** | Dead code, consolidation, hardening                              | 2-3 days | 15%            | 🟡 MEDIUM   |

**Total risk reduction if all phases completed**: 95% (from 73 issues → 3 remaining)

---

## Success Criteria

### Phase 1 (Critical Fixes)

- ✅ No subprocess deadlocks (tested with large codebase)
- ✅ No state.json corruption (concurrent access test)
- ✅ All DB operations gracefully handle edge cases
- ✅ No stack overflow on symlink cycles
- ✅ No SQL injection vulnerabilities

### Phase 2 (Test Infrastructure)

- ✅ All unit tests pass consistently (run 10x)
- ✅ E2E tests pass in parallel
- ✅ Coverage > 80%
- ✅ CI runs in < 5 minutes

### Phase 3 (API Compliance)

- ✅ Plugin config is synchronous
- ✅ Tools return objects, not JSON strings
- ✅ UI doesn't freeze during indexing
- ✅ OpenCode SDK validation passes

### Phase 4 (Code Quality)

- ✅ No dead code
- ✅ No type duplication
- ✅ Parser tests cover edge cases
- ✅ Biome linter is clean
- ✅ New developers can onboard in < 1 hour

---

## Getting Started

1. **Create a feature branch**: `git checkout -b fix/stability-phase-1`
2. **Implement Phase 1 fixes** (use `05-critical-fixes.md` as guide)
3. **Run tests**: `bun test` (must all pass)
4. **Lint**: `biome ci .` (must be clean)
5. **Smoke test** with real Doodba project
6. **Create PR** with this analysis as description
7. **Follow up** with Phase 2-4 in subsequent PRs

---

## Questions & Escalation

- **"Can we delay the critical fixes?"** No. These cause crashes and data loss. Customers are blocked.
- **"Can we combine all phases?"** Not realistically. Focus on Phase 1; parallelize 2-3 if possible.
- **"Do we need all parser unit tests?"** Phase 4 can wait, but Phase 1-3 unblock core functionality.
- **"What's the backwards compatibility impact?"** Phase 1-3 are internal refactors. No API changes for users.

---

## Appendix: Files to Focus On

| Priority | File                                                          | Issues | Effort          |
| -------- | ------------------------------------------------------------- | ------ | --------------- |
| 🔴       | `.opencode/plugins/doodba-dev.js`                             | 9      | 2 days          |
| 🔴       | `src/database.ts`                                             | 8      | 1.5 days        |
| 🔴       | `src/indexer.ts`                                              | 7      | 1.5 days        |
| 🟠       | `src/parsers/python-ast.ts`                                   | 6      | 1 day           |
| 🟠       | `tests/unit/*.test.ts`                                        | 6      | 1.5 days        |
| 🟠       | `tests/e2e/*.test.ts`                                         | 8      | 2 days          |
| 🟡       | `src/parsers/manifest.ts`                                     | 3      | 0.5 days        |
| 🟡       | `src/parsers/python-regex.ts`                                 | 4      | 0 days (delete) |
| 🟡       | Configuration files (package.json, tsconfig.json, biome.json) | 6      | 0.5 days        |

**Total effort if all items completed**: ~12 days of focused work

# 02: Parser Ecosystem Analysis

**Context**: This section covers the parsing layer: Python AST extraction, regex fallback, XML/CSV/manifest parsing, and the Python subprocess orchestration.

**Files analyzed**:
- `src/parsers/python-ast.ts`
- `src/parsers/python-regex.ts`
- `src/parsers/python_ast_extract.py`
- `src/parsers/types.ts`
- `src/parsers/utils.ts`
- `src/parsers/csv.ts`
- `src/parsers/manifest.ts`
- `src/parsers/xml.ts`

---

## Tech Stack

- **Python AST parsing**: Child process `spawnSync` → `python_ast_extract.py` (Python `ast` module)
- **Python fallback**: `python-regex.ts` (pure TS, never used)
- **XML parsing**: `fast-xml-parser` v5.6.0 (only runtime dependency)
- **CSV parsing**: Custom hand-rolled RFC 4180 state machine
- **Manifest parsing**: Regex + bracket scanning (for Python dict literal)
- **Type definitions**: `ParsedItem`, `ItemReference`, and duplicates in `python-regex.ts`

---

## 🔴 Critical Issues

### 1. Synchronous `spawnSync` Blocks Event Loop for 10+ Seconds Per File

**File/Line**: `src/parsers/python-ast.ts:23`

**Severity**: 🔴 Critical — Event loop blocking, terrible performance

**Description**:
The `parsePythonAst` function spawns a synchronous subprocess for EVERY Python file being indexed. With a 10-second timeout per file, indexing 1000 files takes 10,000 seconds minimum (nearly 3 hours), and the OpenCode UI is completely frozen during this time because `spawnSync` blocks the Node.js event loop.

**Evidence**:
```typescript
// src/parsers/python-ast.ts:23
const result = spawnSync(PYTHON_BINARY, [SCRIPT_PATH, filePath, module], {
  encoding: "utf-8",
  timeout: PYTHON_SUBPROCESS_TIMEOUT_MS  // 10_000 ms = 10 seconds
})
```

**Impact**:
- Indexing a medium codebase (1000+ files) takes hours
- OpenCode UI freezes completely during indexing
- Each file is a separate process spawn/exec overhead
- No parallelism possible (synchronous API)

**Fix** (Option 1: Batch process):
```typescript
// Spawn ONE Python process, send multiple files, get back all results
let pythonProcess: Bun.Subprocess | undefined

function initPythonWorker() {
  pythonProcess = Bun.spawn(
    [PYTHON_BINARY, SCRIPT_PATH],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  )
}

async function parsePythonAsyncBatch(files: Array<{path: string, module: string}>): Promise<ParsedItem[][]> {
  if (!pythonProcess) initPythonWorker()
  
  const allItems: ParsedItem[][] = []
  for (const { path, module } of files) {
    pythonProcess.stdin.write(JSON.stringify({ path, module }) + "\n")
  }
  
  // Read back results (one JSON object per line)
  const reader = pythonProcess.stdout.getReader()
  for (const file of files) {
    const result = await reader.read()  // <-- Non-blocking!
    allItems.push(JSON.parse(new TextDecoder().decode(result.value)))
  }
  
  return allItems
}
```

**Fix** (Option 2: Async spawn with Promise):
```typescript
async function parsePythonAstAsync(filePath: string, module: string): Promise<ParsedItem[]> {
  const SCRIPT_PATH = join(__dirname, "python_ast_extract.py")
  const PYTHON_BINARY = "python3"
  
  return new Promise((resolve, reject) => {
    const proc = Bun.spawn(
      [PYTHON_BINARY, SCRIPT_PATH, filePath, module],
      { stdout: "pipe", stderr: "pipe" }
    )
    
    let stdout = ""
    let stderr = ""
    
    proc.stdout.pipeTo(new WritableStream({ write: chunk => {
      stdout += new TextDecoder().decode(chunk)
    }}))
    
    proc.stderr.pipeTo(new WritableStream({ write: chunk => {
      stderr += new TextDecoder().decode(chunk)
    }}))
    
    setTimeout(() => {
      proc.kill("SIGKILL")
      reject(new Error(`Parser timeout for ${filePath}`))
    }, 10_000)
    
    proc.onExit.then(code => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout))
        } catch (e) {
          reject(new Error(`Failed to parse Python output: ${e}`))
        }
      } else {
        reject(new Error(`Python parser exited with code ${code}: ${stderr}`))
      }
    })
  })
}
```

---

### 2. No `maxBuffer` Protection on `spawnSync` Output

**File/Line**: `src/parsers/python-ast.ts:23`

**Severity**: 🔴 Critical — Out-of-memory crash on large files

**Description**:
The `spawnSync` call does not specify a `maxBuffer` option. If the Python script outputs a very large JSON array (e.g., a model with thousands of fields, or auto-generated code), Node.js will attempt to buffer the entire output in memory. This can cause `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` or heap exhaustion.

**Evidence**:
```typescript
// src/parsers/python-ast.ts:23
const result = spawnSync(PYTHON_BINARY, [SCRIPT_PATH, filePath, module], {
  encoding: "utf-8",
  timeout: PYTHON_SUBPROCESS_TIMEOUT_MS
  // missing: maxBuffer
})
```

**Scenario**:
```python
# auto-generated-fields.py
# A million-line file with a model definition
class MyModel(models.Model):
    field_001 = fields.Char()
    field_002 = fields.Char()
    # ... 100,000 fields ...
    field_100000 = fields.Char()

# Python AST extracts this into JSON. Output is ~50 MB.
# Node.js default maxBuffer = 1 MB
# Result: ERR_CHILD_PROCESS_STDIO_MAXBUFFER
```

**Impact**:
- Indexing crashes on large auto-generated files
- Users cannot index modern codebases with massive models

**Fix**:
```typescript
const result = spawnSync(PYTHON_BINARY, [SCRIPT_PATH, filePath, module], {
  encoding: "utf-8",
  timeout: PYTHON_SUBPROCESS_TIMEOUT_MS,
  maxBuffer: 50 * 1024 * 1024,  // 50 MB buffer
})
```

And add file size validation:
```typescript
function parsePythonAst(filePath: string, module: string): ParsedItem[] {
  const stat = statSync(filePath)
  if (stat.size > 50 * 1024 * 1024) {
    console.warn(`[python-ast] skipping giant file (${stat.size} bytes): ${filePath}`)
    return []
  }
  
  const result = spawnSync(PYTHON_BINARY, [SCRIPT_PATH, filePath, module], {
    encoding: "utf-8",
    timeout: PYTHON_SUBPROCESS_TIMEOUT_MS,
    maxBuffer: 50 * 1024 * 1024,
  })
  // ...
}
```

---

### 3. Silent Error Swallowing in Python Parser

**File/Line**: `src/parsers/python-ast.ts:35`

**Severity**: 🔴 Critical — Invisible failures, incomplete indexing

**Description**:
The `parsePythonAst` function has a bare `catch { return [] }` that swallows **all** errors silently. This includes:
- `JSON.parse` failures (malformed JSON from Python)
- `spawnSync` failures (`ENOENT` if Python not found)
- Timeout/signal kills (`SIGKILL`)
- Out-of-memory errors

Callers cannot distinguish "file had no items" from "parser crashed and we're hiding it."

**Evidence**:
```typescript
// src/parsers/python-ast.ts:35
} catch {
  return []  // <-- ALL exceptions → silent empty array
}
```

**Impact**:
- Parser failures are completely invisible to users
- Indexing appears successful but is actually incomplete
- No way to debug or understand why files weren't indexed

**Fix**:
```typescript
function parsePythonAst(filePath: string, module: string): ParsedItem[] {
  const SCRIPT_PATH = join(__dirname, "python_ast_extract.py")
  const PYTHON_BINARY = "python3"
  
  const result = spawnSync(PYTHON_BINARY, [SCRIPT_PATH, filePath, module], {
    encoding: "utf-8",
    timeout: PYTHON_SUBPROCESS_TIMEOUT_MS,
    maxBuffer: 50 * 1024 * 1024,
  })
  
  if (result.error) {
    console.error(`[python-ast] spawn failed for ${filePath}:`, result.error.message)
    return []
  }
  
  if (result.status !== 0) {
    console.warn(`[python-ast] Python script failed for ${filePath} (exit code ${result.status})`)
    if (result.stderr?.trim()) {
      console.warn(`  stderr: ${result.stderr.trim().split("\n")[0]}`)  // First line only
    }
    return []
  }
  
  try {
    const parsed = JSON.parse(result.stdout)
    if (!Array.isArray(parsed)) {
      console.warn(`[python-ast] unexpected output type for ${filePath}: ${typeof parsed}`)
      return []
    }
    return parsed
  } catch (e) {
    console.error(`[python-ast] failed to parse JSON output for ${filePath}:`, e instanceof Error ? e.message : String(e))
    return []
  }
}
```

And in the indexer, track errors separately:
```typescript
const counters = { indexed: 0, skipped: 0, errors: 0, warnings: 0 }
// ...
if (counters.errors > 0) {
  console.warn(`[indexer] ${counters.errors} files failed to parse (see logs above)`)
}
```

---

### 4. O(n²) String Slicing in Python Regex Parser

**File/Line**: `src/parsers/python-regex.ts:49-50`

**Severity**: 🔴 Critical — Exponential memory and time on large files

**Description**:
The `parsePythonRegex` function loops through the source file and, on each iteration, creates a new string via `src.slice(i)`. This is an O(n) operation done n times, resulting in O(n²) memory allocation and time complexity. On a 10MB file, this creates hundreds of MB of garbage and causes the process to stall.

**Evidence**:
```typescript
// src/parsers/python-regex.ts:49-50
for (let i = 0; i < src.length; ) {
  const match = src.slice(i).match(classNameRe)  // <-- O(n) allocation in loop
  if (!match) break
  // ...
  i = startPos + match[0].length
}
```

**Scenario**:
```
File size: 10 MB
Loop iterations: ~10 MB (worst case, one match per character)
String slices: 10 MB × 10 MB = 100 GB allocated
Memory used: Several GB
Time: Minutes
```

**Impact**:
- Indexing large Python files (>10MB) becomes extremely slow and memory-hungry
- Process may run out of memory or be killed by the OS

**Fix** (Option 1: Use `lastIndex` on the original string):
```typescript
function parsePythonRegex(filePath: string, module: string): ParsedItem[] {
  const src = readFileSync(filePath, "utf-8")
  const items: ParsedItem[] = []
  
  // Create regex with 'g' flag for stateful matching
  const classNameRe = /^class\s+(\w+)\s*\(/gm
  let match
  
  while ((match = classNameRe.exec(src)) !== null) {
    const className = match[1]
    const classStartPos = match.index
    // ... extract class body, etc. ...
    items.push({
      itemType: "model",
      name: className,
      // ...
    })
  }
  
  return items
}
```

**Fix** (Option 2: Delete `parsePythonRegex` entirely):
Since this file is dead code (never imported), consider removing it to reduce maintenance burden. The Python AST parser is the correct implementation.

---

### 5. Unsize-Limited Python File Read in `python_ast_extract.py`

**File/Line**: `src/parsers/python_ast_extract.py:265`

**Severity**: 🔴 Critical — Out-of-memory crash on huge files

**Description**:
The Python script reads the entire file into memory with `Path(file_path).read_text(encoding='utf-8')`. There is no file size check. A user might index a massive auto-generated or corrupted file, and the Python process crashes with `MemoryError`. This error is then swallowed by the TypeScript `catch` block.

**Evidence**:
```python
# src/parsers/python_ast_extract.py:265
source = Path(file_path).read_text(encoding='utf-8')
tree = ast.parse(source)
```

**Impact**:
- Indexing a directory with a huge file silently fails
- Python process crashes with OOM; the error is hidden from the user

**Fix**:
```python
import sys
from pathlib import Path

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB

file_path = sys.argv[1]
stat = Path(file_path).stat()
if stat.st_size > MAX_FILE_SIZE:
    print(json.dumps([]))  # Return empty array
    sys.exit(0)

try:
    source = Path(file_path).read_text(encoding='utf-8')
except MemoryError:
    print(json.dumps([], file=sys.stderr))
    sys.exit(1)
except UnicodeDecodeError:
    print(f"Failed to decode {file_path}", file=sys.stderr)
    sys.exit(1)
```

---

### 6. XXE Vulnerability in XML Parser (Potential)

**File/Line**: `src/parsers/xml.ts:6-10`

**Severity**: 🔴 Critical — Entity expansion / XXE attack surface

**Description**:
The code uses `fast-xml-parser` without explicitly disabling entity parsing. While v5.x disables it by default, the code does not enforce this contract. If OpenCode downgrades the dependency or if `fast-xml-parser` has a regression, malicious XML files could exploit billion-laughs or XXE vulnerabilities.

**Evidence**:
```typescript
// src/parsers/xml.ts:6-10
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  // Missing: processEntities: false
})
```

**Scenario**:
```xml
<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
]>
<root>&lol2;</root>
```

Parser memory explodes trying to expand nested entities.

**Impact**:
- Malicious XML in a module could crash indexing or the entire plugin
- Denial-of-service attack surface

**Fix**:
```typescript
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  processEntities: false,        // Explicit disable
  allowBooleanAttributes: true,
})
```

---

## 🟠 Stability Issues

### 7. Silent Loss of Parser Errors with No Logging

**File/Line**: `src/parsers/python-ast.ts:27-32`

**Severity**: 🟠 High — Invisible failures

**Description**:
When the Python subprocess exits with a non-zero status, the code only logs if `stderr` contains text. If Python crashes silently (segfault, OOM-killer, `SIGKILL` from timeout), there is NO log output.

**Evidence**:
```typescript
// src/parsers/python-ast.ts:27-32
if (result.error || result.status !== 0) {
  if (result.stderr?.trim()) {
    console.warn(`[python-ast] Python script failed for ${filePath}:`, result.stderr.trim())
  }
  return []
}
```

**Impact**:
- Segfaults and OOM kills are completely silent
- Users have no idea why indexing is failing

**Fix**:
```typescript
if (result.error || result.status !== 0) {
  const msg = result.stderr?.trim() || `(exit code ${result.status}, no stderr)`
  console.warn(`[python-ast] Python script failed for ${filePath}: ${msg}`)
  return []
}
```

---

### 8. Fragile Manifest Bracket Scanner (Already covered in 01)

Manifest parser mishandles brackets in strings — see **01-core-backend.md § 10**.

---

### 9. Escaped Quotes Not Handled in Manifest Parser

**File/Line**: `src/parsers/manifest.ts:12-13`

**Severity**: 🟠 High — Silent parsing failure

**Description**:
The `extractStringField` function uses a simple regex that doesn't account for escaped quotes. A manifest with `'name': 'It\'s great'` will stop at the escaped quote.

**Evidence**:
```typescript
// src/parsers/manifest.ts:12-13
new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(src)
// This regex stops at the first unescaped quote
// But src.slice(0, -1) expects the LAST quote to close the string
```

**Scenario**:
```python
{
  "name": "My Module - It's Great",  # Contains apostrophe
}

# Parser extracts: "My Module - It"
# Expected: "My Module - It's Great"
```

**Impact**:
- Module names are silently truncated
- Manifest metadata is lost or corrupted

**Fix**:
Use proper string parsing logic (already covered in **01-core-backend.md**) or delegate to Python:
```typescript
function extractStringField(src: string, key: string): string | null {
  // Match double-quoted strings with proper escape handling
  const regex = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\]|\\.)*)"`)
  const match = regex.exec(src)
  if (match) {
    // Unescape the string
    return match[1].replace(/\\(.)/g, "$1")
  }
  
  // Try single-quoted
  const regexSingle = new RegExp(`'${key}'\\s*:\\s*'((?:[^'\\]|\\.)*)'`)
  const matchSingle = regexSingle.exec(src)
  if (matchSingle) {
    return matchSingle[1].replace(/\\(.)/g, "$1")
  }
  
  return null
}
```

---

### 10. XML Line-Number Lookup Uses String Search (Ambiguous)

**File/Line**: `src/parsers/xml.ts:24`

**Severity**: 🟠 High — Wrong line numbers reported

**Description**:
The code looks up line numbers by searching for the XML ID string directly. If the same ID appears in a comment or attribute value before the actual definition, the wrong line is reported. It also only checks double quotes, missing single-quoted IDs.

**Evidence**:
```typescript
// src/parsers/xml.ts:24
const idx = src.indexOf(id="${id}")
```

**Scenario**:
```xml
<!-- Reference to view_id_001 in a comment -->
<record id="view_id_001" model="ir.ui.view">
  <field name="arch" type="xml">
    <!-- ...other stuff... -->
  </field>
</record>
```

Code finds the `id=` in the comment line, not the `<record>` definition line.

**Impact**:
- Reported line numbers are often incorrect
- Makes debugging harder for users

**Fix**:
```typescript
function findLineNumber(src: string, id: string): number {
  const lines = src.split('\n')
  const idRegex = new RegExp(`id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`)
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip comments
    if (line.trim().startsWith('<!--')) continue
    // Look for the actual id= attribute
    if (idRegex.test(line)) {
      return i + 1  // 1-indexed
    }
  }
  return 1
}
```

---

### 11. CSV Parser Accepts Unclosed Quotes

**File/Line**: `src/parsers/csv.ts:43-46`

**Severity**: 🟠 High — Silent data corruption

**Description**:
The CSV parser accepts unclosed quotes at EOF without warning. A malformed CSV ending with an open quote will push the incomplete field as a complete row.

**Evidence**:
```typescript
// src/parsers/csv.ts:43-46
if (currentField || currentRow.length > 0) {
  currentRow.push(currentField)
  // ^^ If currentField has an unclosed quote, it's still pushed
}
```

**Scenario**:
```csv
"name","value"
"item1","unclosed
```

Parser output:
```
["item1", "unclosed"]  # Missing the closing quote
```

**Impact**:
- Malformed CSV data is indexed as valid
- Data corruption is silent

**Fix**:
```typescript
if (inQuotes && !foundClosingQuote) {
  throw new Error(`Unclosed quote in CSV at line ${lineNumber}`)
}

if (currentField || currentRow.length > 0) {
  currentRow.push(currentField)
}
```

---

### 12. Regex Parsers Miss Reassignments and Field Arguments

**File/Line**: `src/parsers/python-regex.ts:89-91` and `148-151`

**Severity**: 🟠 High — Incomplete or wrong field extraction

**Description**:
The regex parser uses `exec()` without the `g` flag, so it always matches the first occurrence. If a class reassigns `_name` later, the parser uses the wrong value. Similarly, field comodel extraction captures any string argument, not specifically the first positional argument.

**Evidence**:
```typescript
// src/parsers/python-regex.ts:89-91
const nameMatch = RE_NAME.exec(classBody)
// If classBody reassigns _name, this gets the first assignment, not the current one

// src/parsers/python-regex.ts:148-151
const comodelMatch = fieldCtx.match(/fields\.\w+\s*\(\s*['"]([^'"]+)['"]/
// This matches ANY string argument, not necessarily comodel_name
```

**Scenario**:
```python
class MyModel(models.Model):
    _name = "my.model"
    # ...
    _name = "my.model.v2"  # <-- Reassignment is ignored

# Or:
field = fields.Many2one("wrong.model", string="correct.model")
# Regex would match "wrong.model" instead of correct.model
```

**Impact**:
- Field metadata is wrong or incomplete
- Cross-references are broken

**Fix**:
Since this is dead code (never used), delete it. Python AST parser is the correct solution.

---

### 13. Python AST Script Returns Empty on Missing Arguments

**File/Line**: `src/parsers/python_ast_extract.py:307-308`

**Severity**: 🟠 High — Silent invocation bugs

**Description**:
If the Python script is invoked without proper CLI arguments, it exits with code 0 and prints an empty JSON array. This means packaging bugs or command-line errors are completely invisible — the script "succeeds" but produces no output.

**Evidence**:
```python
# src/parsers/python_ast_extract.py:307-308
if len(sys.argv) < 3:
    print(json.dumps([]))
    sys.exit(0)  # <-- Success code!
```

**Impact**:
- Invocation errors fail silently
- Hard to debug if arguments are dropped or mangled

**Fix**:
```python
if len(sys.argv) < 3:
    print(f"Usage: {sys.argv[0]} <file_path> <module_name>", file=sys.stderr)
    sys.exit(1)  # <-- Error code
```

---

## 🟡 Maintenance Issues

### 14. `parsePythonRegex` Is Dead Code

**File/Line**: `src/parsers/python-regex.ts`

**Severity**: 🟡 Medium — Unmaintained code, maintenance burden

**Description**:
The entire `python-regex.ts` file is never imported anywhere. It exists as a "fallback" parser that is never wired into the indexer. The file contains duplicated types (`PythonItem`, `PythonItemReference`) and duplicated utility functions.

**Impact**:
- Dead code increases maintenance burden
- Bugs in dead code go unnoticed
- Duplication means fixes need to be made twice

**Fix**:
Option 1: Delete the file entirely. The Python AST parser is the correct approach.

Option 2: If a fallback is desired, wire it into the indexer:
```typescript
// src/indexer.ts
let items: ParsedItem[] = []
try {
  items = parsePythonAst(f, opts.mod.name)
} catch (e) {
  console.warn(`[indexer] AST parser failed for ${f}, trying regex fallback`)
  items = parsePythonRegex(f, opts.mod.name)
}
```

Then fix all the bugs in `python-regex.ts` (O(n²), missing escape handling, etc.).

---

### 15. Type Duplication: `PythonItem` vs `ParsedItem`

**File/Line**: `src/parsers/python-regex.ts:1-20` vs `src/parsers/types.ts`

**Severity**: 🟡 Medium — Type safety downgrade, maintenance burden

**Description**:
`python-regex.ts` defines `PythonItem` and `PythonItemReference` which are nearly identical to `ParsedItem` and `ItemReference` in `types.ts`. The only difference is that `python-regex.ts` uses `any` instead of `unknown`, which is a type-safety downgrade.

**Evidence**:
```typescript
// python-regex.ts
export interface PythonItem {
  itemType: string
  name: string
  // ... same fields ...
  attributes: Record<string, any>  // <-- any instead of unknown
}

// types.ts
export interface ParsedItem {
  itemType: string
  name: string
  // ... same fields ...
  attributes: Record<string, any>
}
```

**Impact**:
- Type checking is inconsistent
- Changes to `ParsedItem` must be mirrored in `PythonItem`
- `any` allows unsafe operations

**Fix**:
Delete `python-regex.ts` entirely, or refactor to reuse `ParsedItem`/`ItemReference`.

---

### 16. `lineNumberAt` Function Duplicated

**File/Line**: `src/parsers/python-regex.ts:19-25` vs `src/parsers/utils.ts:19-25`

**Severity**: 🟡 Medium — Code duplication

**Description**:
The `lineNumberAt` helper function is defined identically in both `python-regex.ts` and `utils.ts`. This is a maintenance burden — fixes must be made twice.

**Impact**:
- Duplication increases bugs
- Harder to maintain

**Fix**:
Delete from `python-regex.ts`, import from `utils.ts`.

---

### 17. Hardcoded Field Types and Odoo Base Classes

**File/Line**: `src/parsers/python_ast_extract.py:13-22`

**Severity**: 🟡 Medium — Incomplete for custom Odoo codebases

**Description**:
The Python script hardcodes `FIELD_TYPES` and `ODOO_BASES` sets. Custom field types (from `odoo-addons` or internal libraries) or custom model base classes are silently ignored.

**Evidence**:
```python
FIELD_TYPES = {'Char', 'Text', 'Integer', 'Float', ...}
ODOO_BASES = {'models.Model', 'TransientModel', 'AbstractModel'}
```

**Impact**:
- Custom fields are not indexed
- Custom base classes are not recognized
- Incomplete indexing for non-standard Odoo codebases

**Fix**:
Make these configurable via CLI arguments or environment variables:
```python
import os
import json

CUSTOM_FIELD_TYPES = os.getenv('DOODBA_FIELD_TYPES', '').split(',') if os.getenv('DOODBA_FIELD_TYPES') else []
CUSTOM_ODOO_BASES = os.getenv('DOODBA_ODOO_BASES', '').split(',') if os.getenv('DOODBA_ODOO_BASES') else []

FIELD_TYPES = {'Char', 'Text', ...} | set(CUSTOM_FIELD_TYPES)
ODOO_BASES = {'models.Model', ...} | set(CUSTOM_ODOO_BASES)
```

---

### 18. Manual Markdown Loading Instead of Stdlib

**File/Line**: `src/parsers/` (referenced in 03-plugin-architecture.md)

**Severity**: 🟡 Medium — Fragile, duplicates work

**Description**:
The plugin manually implements markdown directory loading and YAML frontmatter parsing instead of using standard libraries.

**Impact**:
- Fragile to edge cases (Windows line endings, comments in YAML, etc.)
- Maintenance burden

**Fix**:
Use `gray-matter` for robust frontmatter parsing (already mentioned in plugin architecture section).

---

### 19. XML Element Handler Uses `any` Type

**File/Line**: `src/parsers/xml.ts:41-106`

**Severity**: 🟡 Medium — Type safety, maintainability

**Description**:
All XML element handlers declare their parameter as `el: any`, completely bypassing TypeScript's type system. Changes to `fast-xml-parser` output shape won't be caught at compile time.

**Impact**:
- Zero type safety for XML structure
- Hard to debug shape mismatches

**Fix**:
Define a proper TypeScript interface for the XML structure:
```typescript
interface XmlRecord {
  "@_id": string
  "@_model": string
  field?: Array<{ "@_name": string; "@_subtype"?: string; "#text"?: string }>
  // ...
}

function handleRecord(el: XmlRecord, ...): ParsedItem | null {
  // Now TypeScript knows the shape
}
```

---

## Summary

**Critical fixes needed**: 6 (spawnSync blocking, maxBuffer, error swallowing, O(n²) slicing, XXE, unsize-limited reads)  
**Stability improvements**: 7 (error logging, manifest parsing, escaped quotes, line numbers, CSV quotes, regex edge cases, Python invocation)  
**Maintenance debt**: 7 (dead code, type duplication, hardcoded configs, manual markdown, weak typing)

**Total issues in this section**: 20 issues across 8 parser files

**Action**: Delete or rehabilitate `python-regex.ts` (dead code), fix Python subprocess handling (critical), add comprehensive error logging, and improve manifest/CSV parsing robustness.

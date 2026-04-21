import { type PythonItem, parsePythonRegex } from "./python-regex"

export type { PythonItem }

// Tree-sitter path removed (was dead code — parsePythonAsync was never called).
// Re-add when tree-sitter-python native compilation is stable.
export function parsePython(filePath: string, module: string): PythonItem[] {
  return parsePythonRegex(filePath, module)
}

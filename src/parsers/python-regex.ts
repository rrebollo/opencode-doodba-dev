import { readFileSync } from "node:fs"

export interface PythonItemReference {
  filePath: string
  lineNumber: number
  referenceType: 'definition' | 'inheritance' | 'many2one' | 'one2many' | 'many2many'
  context: string | null
}

export interface PythonItem {
  itemType: string
  name: string
  parentName: string | null
  module: string
  attributes: Record<string, any>
  references: PythonItemReference[]
}

function lineNumberAt(src: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === "\n") line++
  }
  return line
}

const RE_NAME = /_name\s*=\s*['"]([^'"]+)['"]/
const RE_INHERIT = /_inherit\s*=\s*['"]([^'"]+)['"]/
const RE_DESCRIPTION = /_description\s*=\s*['"]([^'"]+)['"]/
// Multiline field definition support: captures field definitions across multiple lines
// Supports both `field_name = fields.Type(...)` and `field_name: Type = fields.Type(...)`
const RE_FIELD = /^\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*fields\.(\w+)\s*\(/gm
const RE_METHOD = /^\s+def\s+(\w+)\s*\(self/gm
// Decorator extraction is done inline during method parsing (see lines 135-149)
// Route extraction not currently used - field extraction covers route attributes if needed
const RE_COMPUTE = /compute\s*=\s*['"]([^'"]+)['"]/
const RE_STRING = /string\s*=\s*['"]([^'"]+)['"]/
const RE_REQUIRED = /required\s*=\s*(True|False)/

export function parsePythonRegex(filePath: string, module: string): PythonItem[] {
  const items: PythonItem[] = []
  try {
    const src = readFileSync(filePath, "utf-8")

    // Find all classes by searching for "class Name(" pattern and matching balanced parens
    const classNameRe = /^class\s+(\w+)\s*\(/m
    const classes: Array<{ className: string; startIndex: number; endIndex: number }> = []

    for (let i = 0; i < src.length; ) {
      const match = src.slice(i).match(classNameRe)
      if (!match) break

      const startIdx = i + match.index!
      const className = match[1]
      const parenStart = i + match.index! + match[0].length - 1 // Position of '('

      // Find matching closing paren for the class definition
      let parenCount = 1
      let parenEnd = parenStart + 1
      while (parenEnd < src.length && parenCount > 0) {
        if (src[parenEnd] === "(") parenCount++
        if (src[parenEnd] === ")") parenCount--
        parenEnd++
      }

      // Find the colon after the closing paren
      let colonIdx = parenEnd
      while (colonIdx < src.length && src[colonIdx] !== ":") colonIdx++

      if (colonIdx < src.length) {
        classes.push({ className, startIndex: startIdx, endIndex: colonIdx })
        i = colonIdx + 1
      } else {
        i = parenEnd
      }
    }

    if (classes.length === 0) return items

    // Process each class
    for (let i = 0; i < classes.length; i++) {
      const currentClass = classes[i]
      const nextClassIndex = i + 1 < classes.length ? classes[i + 1].startIndex : src.length

      const className = currentClass.className
      const classBody = src.substring(currentClass.startIndex, nextClassIndex)

      try {
        const nameMatch = RE_NAME.exec(classBody)
        const inheritMatch = RE_INHERIT.exec(classBody)
        const descMatch = RE_DESCRIPTION.exec(classBody)
        const modelName = nameMatch?.[1] ?? inheritMatch?.[1] ?? null

        if (modelName) {
          const refType = !nameMatch && inheritMatch ? "inheritance" : "definition"
          const modelRefs: PythonItemReference[] = [
            {
              filePath,
              lineNumber: lineNumberAt(src, currentClass.startIndex),
              referenceType: refType,
              context: className,
            },
          ]
          if (nameMatch && inheritMatch && modelName !== inheritMatch[1]) {
            modelRefs.push({
              filePath,
              lineNumber: lineNumberAt(src, currentClass.startIndex),
              referenceType: "inheritance",
              context: `${modelName} _inherit ${inheritMatch[1]}`,
            })
          }

          items.push({
            itemType: "model",
            name: modelName,
            parentName: null,
            module,
            attributes: {
              class_name: className,
              _inherit: inheritMatch?.[1] ?? null,
              _description: descMatch?.[1] ?? null,
              file_path: filePath,
            },
            references: modelRefs,
          })

          // Fields - search only in this class body
          const RELATIONAL = ["Many2one", "One2many", "Many2many"]
          let fm: RegExpExecArray | null
          const fieldRe = new RegExp(RE_FIELD.source, "gm")
          try {
            while ((fm = fieldRe.exec(classBody)) !== null) {
              const fieldName = fm[1]
              const fieldType = fm[2]
              const fieldCtx = classBody.slice(fm.index, fm.index + 200)
              const computeMatch = RE_COMPUTE.exec(fieldCtx)
              const stringMatch = RE_STRING.exec(fieldCtx)
              const requiredMatch = RE_REQUIRED.exec(fieldCtx)
              const fieldLineNumber = lineNumberAt(src, currentClass.startIndex + fm.index)
              const fieldRefs: PythonItemReference[] = [
                {
                  filePath,
                  lineNumber: fieldLineNumber,
                  referenceType: "definition",
                  context: `${fieldName} = fields.${fieldType}(...)`,
                },
              ]
              if (RELATIONAL.includes(fieldType)) {
                // Note: only detects positional comodel arg, not comodel_name= kwarg form.
                // The AST-based parser (python-ast.ts) handles both forms.
                const comodelMatch = fieldCtx.match(/fields\.\w+\s*\(\s*['"]([^'"]+)['"]/)
                if (comodelMatch) {
                  fieldRefs.push({
                    filePath,
                    lineNumber: fieldLineNumber,
                    referenceType: fieldType.toLowerCase(),
                    context: `${fieldName} → ${comodelMatch[1]}`,
                  })
                }
              }
              items.push({
                itemType: "field",
                name: fieldName,
                parentName: modelName,
                module,
                attributes: {
                  field_type: fieldType,
                  string: stringMatch?.[1] ?? null,
                  compute: computeMatch?.[1] ?? null,
                  required: requiredMatch ? requiredMatch[1] === "True" : false,
                  file_path: filePath,
                },
                references: fieldRefs,
              })
            }
          } catch (fieldErr) {
            console.warn(`[indexer] Error parsing fields in ${className} at ${filePath}:`, fieldErr)
          }

          // Methods - search only in this class body, with decorator support
          let mm: RegExpExecArray | null
          const methodRe = new RegExp(RE_METHOD.source, "gm")
          try {
            while ((mm = methodRe.exec(classBody)) !== null) {
              const methodName = mm[1]
              if (["__init__", "create", "write", "unlink"].includes(methodName)) continue

              // Extract decorators: search backwards from method definition
              const decorators: string[] = []
              const methodLineStart = classBody.lastIndexOf("\n", mm.index) + 1
              let searchIdx = methodLineStart - 1

              while (searchIdx >= 0) {
                const lineEnd = searchIdx
                const lineStart = classBody.lastIndexOf("\n", searchIdx - 1) + 1
                const line = classBody.substring(lineStart, lineEnd + 1).trim()

                if (line.startsWith("@")) {
                  // Extract decorator name
                  const decoratorMatch = line.match(/^@(\w[\w.]*)/)
                  if (decoratorMatch) {
                    decorators.unshift(decoratorMatch[1])
                    searchIdx = lineStart - 2
                  } else {
                    break
                  }
                } else if (line === "") {
                  searchIdx = lineStart - 2
                } else {
                  break
                }
              }

              const attributes: Record<string, any> = { file_path: filePath }
              if (decorators.length > 0) {
                attributes.decorators = decorators
              }

              const methodLineNumber = lineNumberAt(src, currentClass.startIndex + mm.index)
              items.push({
                itemType: "method",
                name: methodName,
                parentName: modelName,
                module,
                attributes,
                references: [
                  {
                    filePath,
                    lineNumber: methodLineNumber,
                    referenceType: "definition",
                    context: methodName,
                  },
                ],
              })
            }
          } catch (methodErr) {
            console.warn(
              `[indexer] Error parsing methods in ${className} at ${filePath}:`,
              methodErr,
            )
          }
        }
      } catch (classErr) {
        console.warn(`[indexer] Error processing class ${className} at ${filePath}:`, classErr)
      }
    }
  } catch (err) {
    console.warn(`[indexer] Failed to parse Python file ${filePath}:`, err)
  }
  return items
}

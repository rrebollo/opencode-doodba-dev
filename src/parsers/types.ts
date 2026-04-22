// src/parsers/types.ts

/**
 * Reference to a source location where an indexed item is defined or referenced.
 * Shared across all parsers — previously duplicated as PythonItemReference.
 */
export interface ItemReference {
  filePath: string
  lineNumber: number
  referenceType:
    | "definition"
    | "inheritance"
    | "many2one"
    | "one2many"
    | "many2many"
  context: string | null
}

/**
 * A single indexed entity produced by any parser.
 * Structurally identical to the former XmlItem, CsvItem, and PythonItem —
 * previously defined separately in each parser module.
 */
export interface ParsedItem {
  itemType: string
  name: string
  parentName: string | null
  module: string
  attributes: Record<string, unknown>
  references: ItemReference[]
}

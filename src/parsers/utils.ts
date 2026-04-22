// src/parsers/utils.ts

/**
 * Qualifies a bare XML ID with the module name.
 * If the id already contains a dot it is assumed to be fully qualified.
 *
 * Examples:
 *   qualifyXmlId("order_form", "sale") → "sale.order_form"
 *   qualifyXmlId("sale.order_form", "sale") → "sale.order_form"
 */
export function qualifyXmlId(id: string, module: string): string {
  return id.includes(".") ? id : `${module}.${id}`
}

/**
 * Returns the 1-based line number of the character at `index` in `src`.
 * Used by parsers to convert byte offsets to line numbers.
 */
export function lineNumberAt(src: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === "\n") line++
  }
  return line
}

/**
 * Normalises a value that may be a single item, an array, undefined, or null
 * into a (possibly empty) array. Used by XML parser to handle fast-xml-parser's
 * behaviour of returning a single object instead of a one-element array.
 */
export function toArray<T>(val: T | T[] | undefined | null): T[] {
  if (val === undefined || val === null) return []
  return Array.isArray(val) ? val : [val]
}

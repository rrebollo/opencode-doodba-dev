import { readFileSync } from "node:fs"
import type { PythonItemReference } from "./python-regex"

export interface CsvItem {
  itemType: string
  name: string
  parentName: string | null
  module: string
  attributes: Record<string, any>
  references?: PythonItemReference[]
}

function parseCsvRfc4180(csvContent: string): string[][] {
  const rows: string[][] = []
  const lines = csvContent.split("\n")
  let currentField = ""
  let insideQuotes = false
  let currentRow: string[] = []

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]
    for (let charIdx = 0; charIdx < line.length; charIdx++) {
      const char = line[charIdx]
      if (char === '"') {
        if (insideQuotes && charIdx + 1 < line.length && line[charIdx + 1] === '"') {
          currentField += '"'
          charIdx++
        } else {
          insideQuotes = !insideQuotes
        }
      } else if (char === "," && !insideQuotes) {
        currentRow.push(currentField)
        currentField = ""
      } else {
        currentField += char
      }
    }
    if (insideQuotes) {
      currentField += "\n"
    } else {
      currentRow.push(currentField)
      currentField = ""
      if (currentRow.some((f) => f.trim())) rows.push(currentRow)
      currentRow = []
    }
  }
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField)
    if (currentRow.some((f) => f.trim())) rows.push(currentRow)
  }
  return rows
}

export function parseCsv(filePath: string, module: string): CsvItem[] {
  const items: CsvItem[] = []
  try {
    const content = readFileSync(filePath, "utf-8")
    const rows = parseCsvRfc4180(content)
    if (rows.length < 2) return items

    const headers = rows[0]
    const idIdx = headers.indexOf("id")
    if (idIdx < 0) return items

    for (const row of rows.slice(1)) {
      const id = row[idIdx]?.trim()
      if (!id) continue
      const xmlId = id.includes(".") ? id : `${module}.${id}`
      const attrs: Record<string, any> = {}
      headers.forEach((h, i) => {
        if (h !== "id" && row[i]) attrs[h] = row[i].trim()
      })
      items.push({ itemType: "xml_id", name: xmlId, parentName: null, module, attributes: attrs })
    }
  } catch {}
  return items
}
import { readFileSync } from "node:fs"
import type { ParsedItem, ItemReference } from "./types"
import { qualifyXmlId } from "./utils"

const CSV_ID_COLUMN = "id"
const ITEM_TYPE_XML_ID = "xml_id"

function parseCsvRfc4180(csvContent: string): string[][] {
  const normalised = csvContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const rows: string[][] = []
  const lines = normalised.split("\n")
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

export function parseCsv(filePath: string, module: string): ParsedItem[] {
  const items: ParsedItem[] = []
  try {
    const content = readFileSync(filePath, "utf-8")
    const rows = parseCsvRfc4180(content)
    if (rows.length < 2) return items

    const headers = rows[0]
    const idIdx = headers.indexOf(CSV_ID_COLUMN)
    if (idIdx < 0) return items

    for (const row of rows.slice(1)) {
      const id = row[idIdx]?.trim()
      if (!id) continue
      const xmlId = qualifyXmlId(id, module)
      const attrs: Record<string, string> = {}
      headers.forEach((h, i) => {
        if (h !== CSV_ID_COLUMN && row[i]) attrs[h] = row[i].trim()
      })
      items.push({ itemType: ITEM_TYPE_XML_ID, name: xmlId, parentName: null, module, attributes: attrs, references: [] })
    }
  } catch (err) {
    console.warn(`[csv] Failed to parse ${filePath}:`, err)
  }
  return items
}
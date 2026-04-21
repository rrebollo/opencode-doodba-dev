import { readFileSync } from "node:fs"
import { XMLParser } from "fast-xml-parser"
import type { PythonItemReference } from "./python-regex"

export interface XmlItem {
  itemType: string
  name: string
  parentName: string | null
  module: string
  attributes: Record<string, any>
  references?: PythonItemReference[]
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
})

function itemTypeFromModel(model: string): string {
  if (model === "ir.ui.view") return "view"
  if (model === "ir.ui.menu") return "menuitem"
  return "record"
}

export function parseXml(filePath: string, module: string): XmlItem[] {
  const items: XmlItem[] = []
  try {
    const src = readFileSync(filePath, "utf-8")
    const doc = parser.parse(src)
    const data = doc?.odoo?.data ?? {}

    // Helper function to qualify XML IDs
    const qualifyId = (id: string): string => (id.includes(".") ? id : `${module}.${id}`)

    // Process records
    if (data.record) {
      const records = Array.isArray(data.record) ? data.record : [data.record]
      for (const rec of records) {
        const id = rec["@_id"] ?? ""
        const model = rec["@_model"] ?? ""
        if (!id) continue
        const xmlId = qualifyId(id)
        const fields: Record<string, any> = {}
        const fieldArr = Array.isArray(rec.field) ? rec.field : rec.field ? [rec.field] : []
        for (const f of fieldArr) {
          if (f["@_name"]) fields[f["@_name"]] = f["@_ref"] ?? f["#text"] ?? ""
        }
        items.push({
          itemType: itemTypeFromModel(model),
          name: xmlId,
          parentName: null,
          module,
          attributes: { model, ...fields },
        })
      }
    }

    // Process menuitems
    if (data.menuitem) {
      const menus = Array.isArray(data.menuitem) ? data.menuitem : [data.menuitem]
      for (const m of menus) {
        const id = m["@_id"] ?? ""
        if (!id) continue
        const xmlId = qualifyId(id)
        items.push({
          itemType: "menuitem",
          name: xmlId,
          parentName: m["@_parent"] ?? null,
          module,
          attributes: {
            name: m["@_name"] ?? "",
            action: m["@_action"] ?? "",
            groups: m["@_groups"] ?? "",
          },
        })
      }
    }

    // Process templates (OWL/QWeb templates)
    if (data.template) {
      const templates = Array.isArray(data.template) ? data.template : [data.template]
      for (const t of templates) {
        const id = t["@_id"] ?? ""
        if (!id) continue
        const xmlId = qualifyId(id)
        items.push({
          itemType: "view",
          name: xmlId,
          parentName: t["@_inherit_id"] ?? null,
          module,
          attributes: { name: t["@_name"] ?? "", inherit_id: t["@_inherit_id"] ?? "" },
        })
      }
    }

    // Process act_window declarations
    if (data.act_window) {
      const acts = Array.isArray(data.act_window) ? data.act_window : [data.act_window]
      for (const a of acts) {
        const id = a["@_id"] ?? ""
        if (!id) continue
        const xmlId = qualifyId(id)
        items.push({
          itemType: "record",
          name: xmlId,
          parentName: null,
          module,
          attributes: {
            name: a["@_name"] ?? "",
            res_model: a["@_res_model"] ?? "",
            view_mode: a["@_view_mode"] ?? "",
            domain: a["@_domain"] ?? "",
          },
        })
      }
    }
  } catch {}
  return items
}

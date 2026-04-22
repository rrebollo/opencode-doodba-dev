import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import type { ParsedItem, ItemReference } from "./types";
import { qualifyXmlId, lineNumberAt, toArray } from "./utils";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  processEntities: false, // Prevent XXE / billion-laughs attacks
});

interface XmlElement {
  ["@_id"]?: string;
  ["@_model"]?: string;
  ["@_name"]?: string;
  ["@_ref"]?: string;
  ["@_parent"]?: string;
  ["@_action"]?: string;
  ["@_groups"]?: string;
  ["@_inherit_id"]?: string;
  ["@_res_model"]?: string;
  ["@_view_mode"]?: string;
  ["@_domain"]?: string;
  field?: XmlElement | XmlElement[];
  "#text"?: string;
}

function itemTypeFromModel(model: string): string {
  if (model === "ir.ui.view") return "view";
  if (model === "ir.ui.menu") return "menuitem";
  return "record";
}

function makeDefinitionRef(
  filePath: string,
  src: string,
  id: string,
  context: string
): ItemReference {
  const idx = src.indexOf(`id="${id}"`);
  const lineNumber = idx === -1 ? 0 : lineNumberAt(src, idx);
  return {
    filePath,
    lineNumber,
    referenceType: "definition",
    context,
  };
}

type ElementHandler = (
  el: XmlElement,
  module: string,
  filePath: string,
  src: string
) => ParsedItem | null;

function handleRecord(
  el: XmlElement,
  module: string,
  filePath: string,
  src: string
): ParsedItem | null {
  const id = el["@_id"] ?? "";
  if (!id) return null;
  const model = el["@_model"] ?? "";
  const xmlId = qualifyXmlId(id, module);
  const fields: Record<string, unknown> = {};
  const fieldArr = toArray(el.field);
  for (const f of fieldArr) {
    if (f["@_name"]) fields[f["@_name"]] = f["@_ref"] ?? f["#text"] ?? "";
  }
  // Alias the 'type' field to 'view_type' for ir.ui.view records so MCP tools
  // can filter by attributes.view_type consistently (the field is named 'type' in XML).
  if (model === "ir.ui.view" && typeof fields["type"] === "string" && fields["type"]) {
    fields["view_type"] = fields["type"];
  }
  return {
    itemType: itemTypeFromModel(model),
    name: xmlId,
    parentName: null,
    module,
    attributes: { model, ...fields },
    references: [makeDefinitionRef(filePath, src, id, `<record id="${id}" model="${model}">`)],
  };
}

function handleMenuitem(
  el: XmlElement,
  module: string,
  filePath: string,
  src: string
): ParsedItem | null {
  const id = el["@_id"] ?? "";
  if (!id) return null;
  const xmlId = qualifyXmlId(id, module);
  return {
    itemType: "menuitem",
    name: xmlId,
    parentName: el["@_parent"] ?? null,
    module,
    attributes: {
      name: el["@_name"] ?? "",
      action: el["@_action"] ?? "",
      groups: el["@_groups"] ?? "",
    },
    references: [makeDefinitionRef(filePath, src, id, `<menuitem id="${id}">`)],
  };
}

function handleTemplate(
  el: XmlElement,
  module: string,
  filePath: string,
  src: string
): ParsedItem | null {
  const id = el["@_id"] ?? "";
  if (!id) return null;
  const xmlId = qualifyXmlId(id, module);
  return {
    itemType: "view",
    name: xmlId,
    parentName: el["@_inherit_id"] ?? null,
    module,
    attributes: { name: el["@_name"] ?? "", inherit_id: el["@_inherit_id"] ?? "" },
    references: [makeDefinitionRef(filePath, src, id, `<template id="${id}">`)],
  };
}

function handleActWindow(
  el: XmlElement,
  module: string,
  filePath: string,
  src: string
): ParsedItem | null {
  const id = el["@_id"] ?? "";
  if (!id) return null;
  const xmlId = qualifyXmlId(id, module);
  return {
    itemType: "record",
    name: xmlId,
    parentName: null,
    module,
    attributes: {
      name: el["@_name"] ?? "",
      res_model: el["@_res_model"] ?? "",
      view_mode: el["@_view_mode"] ?? "",
      domain: el["@_domain"] ?? "",
    },
    references: [makeDefinitionRef(filePath, src, id, `<act_window id="${id}">`)],
  };
}

const ELEMENT_HANDLERS: Record<string, ElementHandler> = {
  record: handleRecord,
  menuitem: handleMenuitem,
  template: handleTemplate,
  act_window: handleActWindow,
};

export function parseXml(filePath: string, module: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  try {
    const src = readFileSync(filePath, "utf-8");
    const doc = parser.parse(src);
    const data = doc?.odoo?.data ?? {};

    // Iterate over element handlers
    for (const [elementName, handler] of Object.entries(ELEMENT_HANDLERS)) {
      const elements = toArray(data[elementName]);
      for (const el of elements) {
        const item = handler(el, module, filePath, src);
        if (item) items.push(item);
      }
    }
  } catch (err) {
    console.warn(`[xml] Failed to parse ${filePath}:`, err);
  }
  return items;
}

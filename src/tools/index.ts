import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { tool, type ToolContext } from "@opencode-ai/plugin"
import { DoodbaIndexDatabase } from "../database"
import { globToRegex } from "../glob"
import { getProjectDbPath, readState, type IndexerState } from "../project-state"

function withDb<T>(projectDir: string, fn: (db: DoodbaIndexDatabase) => T): Promise<T> {
  const dbPath = getProjectDbPath(projectDir)
  const db = new DoodbaIndexDatabase(dbPath)
  try {
    return Promise.resolve(fn(db))
  } finally {
    db.close()
  }
}

function formatResponse(status: IndexerState["status"], results: any, message?: string): string {
  const payload: any = { _doodba_status: status }
  if (message) payload._message = message
  payload.results = results ?? []
  return JSON.stringify(payload, null, 2)
}

function checkReady(projectDir: string): { ready: true } | { ready: false; status: IndexerState["status"]; message: string } {
  const state = readState(projectDir)
  if (state.status === "READY") {
    return { ready: true }
  }
  const messages: Record<IndexerState["status"], string> = {
    NO_PROJECT: "No Doodba project detected (.copier-answers.yml not found). If you have a Doodba project, make sure you are in its directory or run /doodba-setup.",
    INDEXING: "The indexer is building the database for the first time (2-5 min). Please try again in a few moments.",
    READY: "",
    FAILED: `Indexing error: ${state.error ?? "unknown"}. Run /doodba-setup to retry.`,
  }
  return { ready: false, status: state.status, message: messages[state.status] }
}

export const doodbaTools = {
  doodba_search: tool({
    description:
      "Search for Odoo models, fields, views, or methods in the index. Use the `type` parameter to filter by entity type (model/field/view/method/menuitem/xml_id). Use `parent` to scope fields to a specific model (e.g., parent='sale.order' to find fields on that model only).",
    args: {
      query: tool.schema.string().describe("Search term (model name, field name, etc.)"),
      type: tool.schema
        .enum(["model", "field", "view", "method", "menuitem", "xml_id"])
        .optional()
        .describe("Item type filter"),
      module: tool.schema.string().optional().describe("Filter by module name"),
      parent: tool.schema
        .string()
        .optional()
        .describe("Filter by parent (e.g., model name for fields)"),
      limit: tool.schema.number().optional().describe("Max results (default 50)"),
    },
    async execute(args, context: ToolContext) {
      const ready = checkReady(context.directory)
      if (!ready.ready) {
        const notReady = ready as { ready: false; status: IndexerState["status"]; message: string }
        return formatResponse(notReady.status, [], notReady.message)
      }
      try {
        const results = await withDb(context.directory, (db) =>
          db.search({
            query: args.query,
            itemType: args.type,
            parentName: args.parent,
            module: args.module,
            limit: args.limit,
          }),
        )
        return formatResponse("READY", results, undefined)
      } catch (e) {
        return formatResponse("FAILED", [], e instanceof Error ? e.message : String(e))
      }
    },
  }),

  doodba_get_details: tool({
    description:
      "Get detailed info about a specific Odoo entity. Returns field types, method signatures, view XML, or menuitem hierarchy depending on entity type.",
    args: {
      name: tool.schema.string().describe("Entity name (e.g., 'sale.order')"),
      type: tool.schema
        .enum(["model", "field", "view", "method", "menuitem", "xml_id"])
        .describe("Entity type"),
    },
    async execute(args, context: ToolContext) {
      const ready = checkReady(context.directory)
      if (!ready.ready) {
        const notReady = ready as { ready: false; status: IndexerState["status"]; message: string }
        return formatResponse(notReady.status, null, notReady.message)
      }
      try {
        const result = await withDb(context.directory, (db) => db.getDetails(args.name, args.type))
        return formatResponse("READY", result, undefined)
      } catch (e) {
        return formatResponse("FAILED", null, e instanceof Error ? e.message : String(e))
      }
    },
  }),

  doodba_list_modules: tool({
    description: "List all indexed Odoo modules.",
    args: {
      pattern: tool.schema
        .string()
        .optional()
        .describe("Optional glob-style filter (e.g., 'sale*')"),
    },
    async execute(args, context: ToolContext) {
      const ready = checkReady(context.directory)
      if (!ready.ready) {
        const notReady = ready as { ready: false; status: IndexerState["status"]; message: string }
        return formatResponse(notReady.status, [], notReady.message)
      }
      try {
        let modules = await withDb(context.directory, (db) => db.listModules())
        if (args.pattern) {
          const re = globToRegex(args.pattern)
          modules = modules.filter((m) => re.test(m))
        }
        return formatResponse("READY", modules, undefined)
      } catch (e) {
        return formatResponse("FAILED", [], e instanceof Error ? e.message : String(e))
      }
    },
  }),

  doodba_module_stats: tool({
    description: "Get item count statistics for an Odoo module.",
    args: { module: tool.schema.string().describe("Module name") },
    async execute(args, context: ToolContext) {
      const ready = checkReady(context.directory)
      if (!ready.ready) {
        const notReady = ready as { ready: false; status: IndexerState["status"]; message: string }
        return formatResponse(notReady.status, {}, notReady.message)
      }
      try {
        const stats = await withDb(context.directory, (db) => db.moduleStats(args.module))
        return formatResponse("READY", stats, undefined)
      } catch (e) {
        return formatResponse("FAILED", {}, e instanceof Error ? e.message : String(e))
      }
    },
  }),

  doodba_find_refs: tool({
    description:
      "Find all references to a model or field in the index. Returns file_path, line_number, reference_type, and context for each reference.",
    args: {
      name: tool.schema.string().describe("Entity name"),
      type: tool.schema.enum(["model", "field", "view", "method"]).describe("Entity type"),
    },
    async execute(args, context: ToolContext) {
      const ready = checkReady(context.directory)
      if (!ready.ready) {
        const notReady = ready as { ready: false; status: IndexerState["status"]; message: string }
        return formatResponse(notReady.status, [], notReady.message)
      }
      try {
        const refs = await withDb(context.directory, (db) => db.findRefs(args.name, args.type))
        return formatResponse("READY", refs, undefined)
      } catch (e) {
        return formatResponse("FAILED", [], e instanceof Error ? e.message : String(e))
      }
    },
  }),

  doodba_search_by_attr: tool({
    description: "Search entities by attribute value (e.g., find all required fields).",
    args: {
      type: tool.schema.enum(["model", "field", "view", "method"]).describe("Item type"),
      filters: tool.schema
        .string()
        .describe('JSON object of attribute filters, e.g. {"required": true}'),
      module: tool.schema.string().optional().describe("Filter by module"),
    },
    async execute(args, context: ToolContext) {
      const ready = checkReady(context.directory)
      if (!ready.ready) {
        const notReady = ready as { ready: false; status: IndexerState["status"]; message: string }
        return formatResponse(notReady.status, [], notReady.message)
      }
      try {
        let filters: Record<string, any>
        try {
          filters = JSON.parse(args.filters)
        } catch {
          return formatResponse("FAILED", [], "Error: filters must be valid JSON")
        }
        const results = await withDb(context.directory, (db) => db.searchByAttr(args.type, filters, args.module))
        return formatResponse("READY", results, undefined)
      } catch (e) {
        return formatResponse("FAILED", [], e instanceof Error ? e.message : String(e))
      }
    },
  }),

  doodba_search_xml_id: tool({
    description: "Search for Odoo XML IDs (external IDs).",
    args: {
      query: tool.schema.string().describe("Search term"),
      module: tool.schema.string().optional().describe("Filter by module"),
      limit: tool.schema.number().optional().describe("Max results"),
    },
    async execute(args, context: ToolContext) {
      const ready = checkReady(context.directory)
      if (!ready.ready) {
        const notReady = ready as { ready: false; status: IndexerState["status"]; message: string }
        return formatResponse(notReady.status, [], notReady.message)
      }
      try {
        const results = await withDb(context.directory, (db) => db.searchXmlId(args.query, args.module, args.limit))
        return formatResponse("READY", results, undefined)
      } catch (e) {
        return formatResponse("FAILED", [], e instanceof Error ? e.message : String(e))
      }
    },
  }),

  doodba_update_index: tool({
    description: "Re-index Odoo source code. Provide root paths containing Odoo modules.",
    args: {
      paths: tool.schema
        .string()
        .describe(
          "Comma-separated root paths to index (e.g., /path/to/odoo/addons,/path/to/custom/addons)",
        ),
      modules: tool.schema
        .string()
        .optional()
        .describe("Comma-separated module names to index (default: all)"),
      full: tool.schema.boolean().optional().describe("Full re-index (clear existing data first)"),
    },
    async execute(args, context: ToolContext) {
      // doodba_update_index is allowed even when not ready — it forces indexing
      try {
        const rootPaths = args.paths
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
        const BLOCKED_ROOTS = ["/", homedir()]
        for (const p of rootPaths) {
          if (!existsSync(p) || !statSync(p).isDirectory()) {
            return formatResponse("FAILED", [], `Error: "${p}" does not exist or is not a directory`)
          }
          if (BLOCKED_ROOTS.includes(p)) {
            return formatResponse("FAILED", [], `Error: "${p}" is too broad. Provide a specific Odoo module or project directory.`)
          }
        }
        const modules = args.modules
          ? args.modules
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean)
          : undefined
        const { indexModules } = await import("../indexer")
        const result = indexModules({ rootPaths, modules, full: args.full, dbPath: getProjectDbPath(context.directory) })
        return formatResponse("READY", result, `Index updated: ${result.indexed} files indexed, ${result.skipped} skipped (unchanged), ${result.errors} errors`)
      } catch (e) {
        return formatResponse("FAILED", [], e instanceof Error ? e.message : String(e))
      }
    },
  }),

  doodba_index_status: tool({
    description: "Show current index status (item counts, last indexed timestamp).",
    args: {},
    async execute(_args, context: ToolContext) {
      const ready = checkReady(context.directory)
      if (!ready.ready) {
        const notReady = ready as { ready: false; status: IndexerState["status"]; message: string }
        return formatResponse(notReady.status, {}, notReady.message)
      }
      try {
        const state = readState(context.directory)
        const dbStatus = await withDb(context.directory, (db) => db.indexStatus())
        const status = {
          ...dbStatus,
          missingDeps: state.missingDeps,
        }
        return formatResponse("READY", status, undefined)
      } catch (e) {
        return formatResponse("FAILED", {}, e instanceof Error ? e.message : String(e))
      }
    },
  }),
}

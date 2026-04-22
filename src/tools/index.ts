import { existsSync, statSync } from "node:fs";
import { tool, type ToolContext } from "@opencode-ai/plugin";
import { globToRegex } from "../glob";
import { getProjectDbPath, readState } from "../project-state";
import {
  ENTITY_TYPES,
  REF_ENTITY_TYPES,
  BLOCKED_ROOTS,
  executeWithReadyCheck,
  formatResponse,
  resolveProjectDir,
  toErrorMessage,
} from "./helpers";

export const doodbaTools = {
  doodba_search: tool({
    description:
      "Search for Odoo models, fields, views, or methods in the index. Use the `type` parameter to filter by entity type (model/field/view/method/menuitem/xml_id). Use `parent` to scope fields to a specific model (e.g., parent='sale.order' to find fields on that model only).",
    args: {
      query: tool.schema.string().describe("Search term (model name, field name, etc.)"),
      type: tool.schema.enum(ENTITY_TYPES).optional().describe("Item type filter"),
      module: tool.schema.string().optional().describe("Filter by module name"),
      parent: tool.schema
        .string()
        .optional()
        .describe("Filter by parent (e.g., model name for fields)"),
      limit: tool.schema.number().optional().describe("Max results (default 50)"),
    },
    execute(args, context: ToolContext) {
      return executeWithReadyCheck(context.directory, [], (db) =>
        db.search({
          query: args.query,
          itemType: args.type,
          parentName: args.parent,
          module: args.module,
          limit: args.limit,
        })
      );
    },
  }),

  doodba_get_details: tool({
    description:
      "Get detailed info about a specific Odoo entity. Returns field types, method signatures, view XML, or menuitem hierarchy depending on entity type.",
    args: {
      name: tool.schema.string().describe("Entity name (e.g., 'sale.order')"),
      type: tool.schema.enum(ENTITY_TYPES).describe("Entity type"),
    },
    execute(args, context: ToolContext) {
      return executeWithReadyCheck(context.directory, null, (db) =>
        db.getDetails(args.name, args.type)
      );
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
    execute(args, context: ToolContext) {
      return executeWithReadyCheck(context.directory, [], (db) => {
        let modules = db.listModules();
        if (args.pattern) {
          const re = globToRegex(args.pattern);
          modules = modules.filter((m) => re.test(m));
        }
        return modules;
      });
    },
  }),

  doodba_module_stats: tool({
    description: "Get item count statistics for an Odoo module.",
    args: { module: tool.schema.string().describe("Module name") },
    execute(args, context: ToolContext) {
      return executeWithReadyCheck(context.directory, {}, (db) => db.moduleStats(args.module));
    },
  }),

  doodba_find_refs: tool({
    description:
      "Find all references to a model or field in the index. Returns file_path, line_number, reference_type, and context for each reference.",
    args: {
      name: tool.schema.string().describe("Entity name"),
      type: tool.schema.enum(REF_ENTITY_TYPES).describe("Entity type"),
    },
    execute(args, context: ToolContext) {
      return executeWithReadyCheck(context.directory, [], (db) =>
        db.findRefs(args.name, args.type)
      );
    },
  }),

  doodba_search_by_attr: tool({
    description: "Search entities by attribute value (e.g., find all required fields).",
    args: {
      type: tool.schema.enum(REF_ENTITY_TYPES).describe("Item type"),
      filters: tool.schema
        .string()
        .describe('JSON object of attribute filters, e.g. {"required": true}'),
      module: tool.schema.string().optional().describe("Filter by module"),
    },
    execute(args, context: ToolContext) {
      return executeWithReadyCheck(context.directory, [], (db) => {
        let filters: Record<string, unknown>;
        try {
          filters = JSON.parse(args.filters);
        } catch {
          throw new Error("Error: filters must be valid JSON");
        }
        return db.searchByAttr(args.type, filters, args.module);
      });
    },
  }),

  doodba_search_xml_id: tool({
    description: "Search for Odoo XML IDs (external IDs).",
    args: {
      query: tool.schema.string().describe("Search term"),
      module: tool.schema.string().optional().describe("Filter by module"),
      limit: tool.schema.number().optional().describe("Max results"),
    },
    execute(args, context: ToolContext) {
      return executeWithReadyCheck(context.directory, [], (db) =>
        db.searchXmlId(args.query, args.module, args.limit)
      );
    },
  }),

  doodba_update_index: tool({
    description: "Re-index Odoo source code. Provide root paths containing Odoo modules.",
    args: {
      paths: tool.schema
        .string()
        .describe(
          "Comma-separated root paths to index (e.g., /path/to/odoo/addons,/path/to/custom/addons)"
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
          .filter(Boolean);
        for (const p of rootPaths) {
          if (!existsSync(p) || !statSync(p).isDirectory()) {
            return formatResponse(
              "FAILED",
              [],
              `Error: "${p}" does not exist or is not a directory`
            );
          }
          if (BLOCKED_ROOTS.includes(p)) {
            return formatResponse(
              "FAILED",
              [],
              `Error: "${p}" is too broad. Provide a specific Odoo module or project directory.`
            );
          }
        }
        const modules = args.modules
          ? args.modules
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean)
          : undefined;
        const { indexModules } = await import("../indexer");
        const resolved = resolveProjectDir(context.directory);
        const result = indexModules({
          rootPaths,
          modules,
          full: args.full,
          dbPath: getProjectDbPath(resolved),
        });
        return formatResponse(
          "READY",
          result,
          `Index updated: ${result.indexed} files indexed, ${result.skipped} skipped (unchanged), ${result.errors} errors`
        );
      } catch (e) {
        return formatResponse("FAILED", [], toErrorMessage(e));
      }
    },
  }),

  doodba_index_status: tool({
    description: "Show current index status (item counts, last indexed timestamp).",
    args: {},
    execute(_args, context: ToolContext) {
      return executeWithReadyCheck(
        context.directory,
        { missingDeps: [], totalItems: 0, totalModules: 0, lastIndexed: null },
        (db, projectDir) => {
          const state = readState(projectDir);
          const dbStatus = db.indexStatus();
          return {
            ...dbStatus,
            missingDeps: state.missingDeps,
          };
        }
      );
    },
  }),
};

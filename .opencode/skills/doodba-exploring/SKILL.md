---
name: doodba-exploring
description: Fast indexer for Odoo codebases - 95% more token-efficient than reading files. USE AUTOMATICALLY AND PROACTIVELY before ANY Odoo code work. AUTO-TRIGGER when user mentions models (sale.order, res.partner, account.move, etc.), fields (partner_id, name, state, etc.), views (form, tree, kanban), XML IDs, or when you need to search/validate/explore Odoo code. USE BEFORE writing code to validate references exist, USE BEFORE reading files to locate elements, USE DURING debugging to trace dependencies. CRITICAL: Always validate models/fields/xmlids with indexer before using them in code.
---

# Doodba Exploring Skill

Use the `doodba_*` tools to search and explore Odoo code structure instead of reading files.

## When to Auto-Use

- User asks "What is sale.order?" → `doodba_get_details` with type=model
- User asks "What fields does res.partner have?" → `doodba_get_details` with type=model
- User asks "Find all Many2one fields in sale module" → `doodba_search_by_attr`
- User asks "Where is project.task defined?" → `doodba_search` with type=model
- User asks "Does sale.order have partner_id field?" → `doodba_search` with type=field, parent=sale.order
- User asks "Search for task views" → `doodba_search` with type=view
- User asks "List all modules" → `doodba_list_modules`
- User asks "Tell me about the sale module" → `doodba_module_stats`

## Tool Reference

### doodba_search

Search for models, fields, views, methods, menuitems, or xml_ids.

- `query` — search term (supports wildcards)
- `type` — model/field/view/method/menuitem/xml_id
- `module` — filter by module
- `parent` — scope to specific model (for fields)
- `limit` — max results (default 50)

### doodba_get_details

Get complete info about a specific entity.

- `name` — entity name (e.g., "sale.order")
- `type` — entity type
- For `type=method`, the result includes a `decorators` array (e.g., `["api.depends", "api.multi"]`) when decorators are present on the method.

### doodba_list_modules

List all indexed modules. Optional `pattern` filter.

### doodba_module_stats

Get item counts for a module.

- `module` — module name

### doodba_find_refs

Find all references to a model or field.

- `name` — entity name
- `type` — model/field/view/method

### doodba_search_by_attr

Search by attribute values.

- `type` — model/field/view/method
- `filters` — JSON object, e.g. `{"required": true}`
- `module` — optional filter

### doodba_search_xml_id

Search for XML IDs (external IDs).

- `query` — search term
- `module` — optional filter
- `limit` — max results

### doodba_update_index

Re-index Odoo source code.

- `paths` — comma-separated root paths (blocked: `/` and home directory are refused for safety)
- `modules` — optional comma-separated module names
- `full` — clear existing data first

### doodba_index_status

Show index statistics (item counts, last indexed).

## Best Practices

1. Always validate model/field/XML ID references before generating code
2. Use exact names from indexer results — never guess field names
3. Use `doodba_get_details` for comprehensive info on a single entity
4. Use `doodba_search` for finding elements by pattern
5. Use `doodba_search_by_attr` for filtered searches (e.g., all required Many2one fields)
6. Keep index fresh — run `doodba_update_index` after code changes

## Indexed Content Notes

- **QWeb/OWL templates** (`<template>` elements in XML) are indexed as `type=view`. Use `doodba_search` with `type=view` to find them.
- **`<act_window>` declarations** are indexed as `type=record` (not a dedicated action type).
- **Method decorators** are stored in the `attributes.decorators` array on method entities.
- **XML IDs** from CSV data files are indexed as `type=xml_id`.

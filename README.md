# opencode-doodba-dev

[![CI](https://github.com/rrebollo/opencode-doodba-dev/actions/workflows/ci.yml/badge.svg)](https://github.com/rrebollo/opencode-doodba-dev/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/bun-1.3.11-F9F1E1?logo=bun)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

OpenCode plugin for Doodba-based Odoo development. Fast code indexing, environment setup, and test execution.

## Features

- **Search** — Find Odoo models, fields, views, methods by name or pattern
- **Detailed Info** — Get field types, method signatures, view XML, etc.
- **References** — Find all references to a model or field in your codebase
- **Filtering** — Search by attributes (e.g., "required fields") or module
- **Indexing** — Re-index Odoo code with automatic change detection
- **Status** — View current index statistics and metadata
- **Setup** — `/doodba-setup` validates Docker, Python, uv, and builds the indexer
- **Testing** — `/doodba-test` runs module tests via Doodba's `invoke test`

## Installation

Add to your Doodba project's `opencode.json` (in the project root, not your global OpenCode config):

```json
{
  "plugin": ["doodba-dev@git+https://github.com/rrebollo/opencode-doodba-dev.git"]
}
```

This ensures the plugin is only active when you open the Doodba project. Restart OpenCode. The plugin auto-installs and tools auto-register.

## Usage

Nine tools appear in chat immediately after installation:

- **doodba_search** — Search for Odoo models, fields, views, or methods. Use `type` parameter to filter (model/field/view/method/menuitem/xml_id), `parent` to scope to specific model, `module` to filter by module.

- **doodba_get_details** — Get detailed information about a specific Odoo entity. Returns field types, method signatures, view XML, or menuitem hierarchy depending on entity type.

- **doodba_list_modules** — List all indexed Odoo modules. Use optional `pattern` parameter for glob-style filtering (e.g., 'sale\*').

- **doodba_module_stats** — Get item count statistics for a specific Odoo module. Shows counts of models, fields, views, methods, etc.

- **doodba_find_refs** — Find all references to a model or field in the index. Returns file paths, line numbers, reference types, and context for each reference.

- **doodba_search_by_attr** — Search entities by attribute value. For example, find all required fields by passing `{"required": true}` as filters.

- **doodba_search_xml_id** — Search for Odoo XML IDs (external IDs) in the index. Use optional `module` filter and `limit` parameters.

- **doodba_update_index** — Re-index Odoo source code. Provide comma-separated root paths containing Odoo modules. Use `modules` parameter to index specific modules only. Use `full` flag for complete re-index (clears existing data first). Note: `/` and the home directory are blocked for safety.

- **doodba_index_status** — Show current index status including item counts (models, fields, views, etc.) and last indexed timestamp.

## Skills

When a Doodba project is detected, the plugin automatically injects the **`doodba-exploring`** skill into OpenCode. This skill instructs the AI to use the `doodba_*` tools proactively when exploring Odoo code — before reading files, before writing code, and when validating model/field/XML ID references.

## Commands

- **/doodba-setup** — Validate Doodba environment (Docker, Python, uv), detect Odoo path, and build the indexer database.

- **/doodba-test** — Run Odoo module tests using Doodba's `invoke test` command.

## Updating

The plugin is installed once in OpenCode's cache and then frozen at that version. To get a newer version, delete the cache directory and restart OpenCode:

```bash
rm -rf ~/.cache/opencode/packages/doodba-dev@git+https:/github.com/rrebollo/opencode-doodba-dev.git
```

OpenCode will re-install the latest version on next start.

To pin a specific version instead, use a git tag in the URL:

```json
{
  "plugin": ["doodba-dev@git+https://github.com/rrebollo/opencode-doodba-dev.git#v0.1.0"]
}
```

Then delete and re-install (as above) when you want to update to a new pinned version.

## Troubleshooting

### Plugin not loading

1. Check OpenCode logs: `opencode run --print-logs "hello" 2>&1 | grep -i doodba`
2. Verify the plugin line in your `opencode.json` is correct
3. Restart OpenCode

### Tools not appearing

1. Verify plugin is loading (see troubleshooting above)
2. Restart OpenCode
3. Check that your `opencode.json` is valid JSON

## Development

Built with TypeScript and Bun.

```bash
bun install
bun test
```

## License

MIT

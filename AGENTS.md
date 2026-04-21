# AGENTS.md

This file documents non-discoverable landmines for agents working on the opencode-doodba-dev codebase. Only include what cannot be discovered by reading code, imports, or directory structure.

## Tooling

- Use `bun test` for tests — not `npm test` or `jest`
- There is no `build` script in `package.json` — do not run `bun run build`
- `.opencode/plugins/doodba-dev.js` is hand-authored source code, not compiled output — edit it directly

## Architecture Traps

- `.opencode/` serves dual purpose: plugin source files (`plugins/`, `commands/`, `agents/`, `skills/`) AND runtime state written by the installed plugin (`.opencode/doodba-dev/state.json`, `.opencode/doodba-dev/index.db`). These are completely separate concerns.
- SQLite schema in `src/database.ts` must maintain backward compatibility with the Python odoo-indexer CLI. Column names and types are intentionally identical to the aiosqlite version.
- Tree-sitter was removed from `src/parsers/python.ts` intentionally due to native binary compilation instability. Do not re-add without a plan for bundling or lazy-loading native binaries.
- Doodba project detection is convention-based: walks up parent dirs for `.copier-answers.yml`, derives source paths from `odoo/custom/src/*` subdirectories. Changing these conventions requires updates to `src/doodba-detector.ts` and `.opencode/agents/doodba-provisioner.md`.

## Task Routing

When working on specific tasks, these files provide specialized context:

| Task | Location | Purpose |
|------|----------|---------|
| Environment setup (Docker, Python, uv, auto-indexing) | `.opencode/agents/doodba-provisioner.md` | Subagent spec for `/doodba-setup` |
| Running Odoo tests | `.opencode/commands/doodba-test.md` | Command spec for `/doodba-test` |
| Searching/exploring Odoo code | `.opencode/skills/doodba-exploring/SKILL.md` | Skill for index-based exploration |
| Plugin installation & architecture | `README.md`, `.opencode/plugins/doodba-dev.js` | User-facing install guide and plugin entry point |

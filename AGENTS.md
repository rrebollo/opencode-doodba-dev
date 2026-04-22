# AGENTS.md

This file documents non-discoverable landmines for agents working on the opencode-doodba-dev codebase. Only include what cannot be discovered by reading code, imports, or directory structure.

## Tooling

- Use `bun test` for tests — not `npm test` or `jest`
- There is no `build` script in `package.json` — do not run `bun run build`
- `.opencode/plugins/doodba-dev.js` is hand-authored source code, not compiled output — edit it directly

## Architecture Traps

- `.opencode/` in this repo is plugin source only (`plugins/`, `commands/`, `agents/`, `skills/`). Runtime state written by the installed plugin (`state.json`, `index.db`) goes to `<user-doodba-project>/.opencode/doodba-dev/` — a completely separate `.opencode/` in the user's Doodba project directory. They never share a filesystem location.
- `@opencode-ai/plugin` is in **devDependencies** (root `package.json`) for TypeScript type-checking only. OpenCode installs the runtime version independently from `.opencode/package.json`. Do not move it to `dependencies` — that creates a redundant parallel install.
- Commands/agents/skills are injected manually in `DoodbaDevPlugin` (`.opencode/plugins/doodba-dev.js`) rather than relying on OpenCode's native `.opencode/` discovery. This is intentional: native discovery is always-on and cannot be gated on Doodba project detection. The manual injection is what makes these features Doodba-project-only.
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

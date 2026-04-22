/**
 * Indexer worker entry point.
 * Called by Bun.spawn from doodba-dev.js.
 *
 * Arguments: <projectDir> <doodbaRoot> [<sourcePath1> <sourcePath2> ...]
 * Writes JSON result to stdout on completion.
 * Writes errors to stderr.
 */
import { indexModules } from "./indexer";
import { getProjectDbPath, updateState } from "./project-state";
import { getSourcePaths } from "./doodba-detector";

const [, , projectDir, doodbaRoot, ...extraPaths] = process.argv;

if (!projectDir || !doodbaRoot) {
  process.stderr.write("indexer-worker: missing projectDir or doodbaRoot\n");
  process.exit(1);
}

const sourcePaths = extraPaths.length > 0 ? extraPaths : getSourcePaths(doodbaRoot);

if (sourcePaths.length === 0) {
  updateState(projectDir, { status: "FAILED", error: "No source paths found in odoo/custom/src/" });
  process.stdout.write(JSON.stringify({ error: "No source paths" }));
  process.stderr.write("indexer-worker: no Odoo module directories found under odoo/custom/src/\n");
  process.exit(1);
}

updateState(projectDir, { status: "INDEXING", startedAt: new Date().toISOString(), error: null });

try {
  const result = indexModules({
    rootPaths: sourcePaths,
    full: true,
    dbPath: getProjectDbPath(projectDir),
  });
  updateState(projectDir, {
    status: "READY",
    completedAt: new Date().toISOString(),
    indexedFiles: result.indexed,
    missingDeps: result.missingDeps,
    error: null,
  });
  process.stdout.write(JSON.stringify(result));
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  updateState(projectDir, { status: "FAILED", error: msg });
  process.stderr.write(`indexer-worker error: ${msg}\n`);
  process.exit(1);
}

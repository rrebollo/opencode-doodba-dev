/**
 * opencode-doodba-dev plugin for OpenCode.ai
 *
 * This plugin does three things:
 *
 * 1. Registers doodba_* tools always (they self-report gracefully when not in a Doodba project).
 * 2. Conditionally injects commands, agents, and skills ONLY when a Doodba project is detected.
 *    We inject manually (not via OpenCode's native .opencode/ discovery) because native discovery
 *    is always-on and cannot be gated on Doodba project detection.
 * 3. Triggers background auto-indexing when a Doodba project is detected.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// packageRoot: two levels up from .opencode/plugins/ → repo root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "../..");

/** Maximum age (ms) of an INDEXING state before it is considered stuck and restarted. */
const STUCK_INDEXER_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { frontmatter: Record<string,string>, body: string }.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const val = line
        .slice(colon + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      frontmatter[key] = val;
    }
  }
  return { frontmatter, body: match[2].trim() };
}

/**
 * Load all .md files from dir, returning name → transform(frontmatter, body).
 */
function loadMarkdownDir(dir, transform) {
  const result = {};
  if (!fs.existsSync(dir)) return result;
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf8");
        const { frontmatter, body } = parseFrontmatter(raw);
        result[file.slice(0, -3)] = transform(frontmatter, body);
      } catch (e) {
        console.warn(`[doodba-dev] Failed to load ${path.join(dir, file)}:`, e.message);
      }
    }
  } catch (e) {
    console.warn(`[doodba-dev] Failed to read directory ${dir}:`, e.message);
  }
  return result;
}

/** Track spawned worker processes to prevent zombies and concurrent indexers. */
const SPAWNED_WORKERS = new Map();

/**
 * Spawn the indexer as a background child process via Bun.spawn.
 * Tracks the worker to prevent zombies and pipe-buffer deadlocks.
 */
async function spawnIndexing(projectDir, doodbaRootPath, sourcePaths) {
  // Kill any existing worker for this project to prevent concurrent indexing
  const existing = SPAWNED_WORKERS.get(projectDir);
  if (existing?.worker) {
    try {
      existing.worker.kill("SIGKILL");
    } catch {
      // Already dead
    }
  }

  const workerPath = path.resolve(packageRoot, "src/indexer-worker.ts");

  try {
    const worker = Bun.spawn(["bun", workerPath, projectDir, doodbaRootPath, ...sourcePaths], {
      stdout: "ignore", // Prevent pipe-buffer deadlock
      stderr: "ignore",
    });

    SPAWNED_WORKERS.set(projectDir, { worker, pid: worker.pid });

    // Clean up tracking when process exits (if onExit is available)
    if (worker.onExit) {
      worker.onExit
        .then(() => {
          SPAWNED_WORKERS.delete(projectDir);
        })
        .catch(() => {});
    }
  } catch (e) {
    console.error(`[doodba-dev] Failed to spawn indexer: ${e.message}`);
    // Update state so plugin knows indexing failed
    const { updateState } = await import(path.resolve(packageRoot, "src/project-state.ts"));
    updateState(doodbaRootPath, {
      status: "FAILED",
      error: `Spawn failed: ${e.message}`,
    });
  }
}

/** Acquire a file-based lock to prevent concurrent indexers on the same project. */
function acquireIndexLock(projectDir) {
  const lockDir = path.join(projectDir, ".opencode", "doodba-dev");
  const lockPath = path.join(lockDir, "indexer.lock");

  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  const startTime = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
      );
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
      fs.closeSync(fd);
      return lockPath;
    } catch (e) {
      if (Date.now() - startTime > 5000) {
        throw new Error("Indexer locked by another process", { cause: e });
      }
      // Sleep 100ms using a busy-wait (synchronous)
      const start = Date.now();
      while (Date.now() - start < 100) {
        /* busy-wait */
      }
    }
  }
}

/** Release the file-based indexer lock. */
function releaseIndexLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

/**
 * DoodbaDevPlugin — OpenCode plugin factory.
 *
 * Always registers doodba_* tools (they report NO_PROJECT gracefully when not in a Doodba project).
 * Only injects commands, agents, and skills config when a Doodba project is detected.
 * Triggers auto-indexing on plugin load when in a Doodba project.
 */
export const DoodbaDevPlugin = async ({ directory }) => {
  // NOTE: These imports use Bun's runtime TypeScript transpilation.
  // This plugin REQUIRES Bun as the JavaScript runtime — Node.js is not supported.
  // If you see "Cannot find module" errors here, ensure OpenCode is running under Bun.
  const [{ doodbaTools }, { findDoodbaRoot, getSourcePaths }, { readState }] = await Promise.all([
    import(path.resolve(packageRoot, "src/tools/index.ts")),
    import(path.resolve(packageRoot, "src/doodba-detector.ts")),
    import(path.resolve(packageRoot, "src/project-state.ts")),
  ]);

  const doodbaRoot = findDoodbaRoot(directory);

  if (!doodbaRoot) {
    // Not a Doodba project — register tools only.
    return { tool: doodbaTools };
  }

  // Doodba project detected — trigger auto-indexing if needed (with lock)
  let lockPath = null;
  try {
    lockPath = acquireIndexLock(doodbaRoot);

    const state = readState(doodbaRoot);
    if (state.status === "INDEXING" && state.startedAt) {
      const stuckMs = Date.now() - new Date(state.startedAt).getTime();
      if (stuckMs > STUCK_INDEXER_TIMEOUT_MS) {
        // Stuck > 30 min — restart
        await spawnIndexing(doodbaRoot, doodbaRoot, getSourcePaths(doodbaRoot));
      }
    } else if (state.status === "NO_PROJECT" || state.status === "FAILED") {
      await spawnIndexing(doodbaRoot, doodbaRoot, getSourcePaths(doodbaRoot));
    }
  } catch (e) {
    console.error(`[doodba-dev] Failed to start indexing: ${e.message}`);
  } finally {
    if (lockPath) releaseIndexLock(lockPath);
  }

  // Load commands and agents from the plugin package for conditional injection
  const commandsDir = path.join(packageRoot, ".opencode/commands");
  const agentsDir = path.join(packageRoot, ".opencode/agents");
  const skillsDir = path.join(packageRoot, ".opencode/skills");

  const commands = loadMarkdownDir(commandsDir, (fm, body) => {
    const cmd = { description: fm.description || "", template: body };
    if (fm.agent) cmd.agent = fm.agent;
    if (fm.subtask === "true") cmd.subtask = true;
    if (fm.model) cmd.model = fm.model;
    return cmd;
  });

  const agents = loadMarkdownDir(agentsDir, (fm, body) => {
    const agent = { description: fm.description || "", mode: fm.mode || "subagent", prompt: body };
    if (fm.model) agent.model = fm.model;
    if (fm.temperature) agent.temperature = parseFloat(fm.temperature);
    if (fm.tools) {
      try {
        agent.tools = JSON.parse(fm.tools);
      } catch (e) {
        console.warn('[doodba-dev] Invalid JSON in frontmatter field "tools":', e.message);
      }
    }
    if (fm.permission) {
      try {
        agent.permission = JSON.parse(fm.permission);
      } catch (e) {
        console.warn('[doodba-dev] Invalid JSON in frontmatter field "permission":', e.message);
      }
    }
    if (fm.hidden === "true") agent.hidden = true;
    if (fm.color) agent.color = fm.color;
    return agent;
  });

  console.log(
    `[doodba-dev] Loaded ${Object.keys(commands).length} commands, ${Object.keys(agents).length} agents (project: ${doodbaRoot})`
  );

  return {
    tool: doodbaTools,

    config: (config) => {
      // Inject skill discovery path
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(skillsDir)) {
        config.skills.paths.push(skillsDir);
      }

      // Inject commands (don't overwrite user-defined ones)
      config.command = config.command || {};
      for (const [name, cmd] of Object.entries(commands)) {
        if (!config.command[name]) config.command[name] = cmd;
      }

      // Inject agents (don't overwrite user-defined ones)
      config.agent = config.agent || {};
      for (const [name, agent] of Object.entries(agents)) {
        if (!config.agent[name]) config.agent[name] = agent;
      }
    },
  };
};

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

import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

// packageRoot: two levels up from .opencode/plugins/ → repo root
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '../..')

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { frontmatter: Record<string,string>, body: string }.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }
  const frontmatter = {}
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':')
    if (colon > 0) {
      const key = line.slice(0, colon).trim()
      const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '')
      frontmatter[key] = val
    }
  }
  return { frontmatter, body: match[2].trim() }
}

/**
 * Load all .md files from dir, returning name → transform(frontmatter, body).
 */
function loadMarkdownDir(dir, transform) {
  const result = {}
  if (!fs.existsSync(dir)) return result
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf8')
        const { frontmatter, body } = parseFrontmatter(raw)
        result[file.slice(0, -3)] = transform(frontmatter, body)
      } catch (e) {
        console.warn(`[doodba-dev] Failed to load ${dir}/${file}:`, e.message)
      }
    }
  } catch (e) {
    console.warn(`[doodba-dev] Failed to read directory ${dir}:`, e.message)
  }
  return result
}

/**
 * Spawn the indexer as a background child process via Bun.spawn.
 * Fire-and-forget: does not await completion.
 */
function spawnIndexing(projectDir, doodbaRootPath, sourcePaths) {
  const workerPath = path.resolve(packageRoot, 'src/indexer-worker.ts')
  Bun.spawn(
    ['bun', workerPath, projectDir, doodbaRootPath, ...sourcePaths],
    { stdout: 'pipe', stderr: 'pipe' }
  )
}

/**
 * DoodbaDevPlugin — OpenCode plugin factory.
 *
 * Always registers doodba_* tools (they report NO_PROJECT gracefully when not in a Doodba project).
 * Only injects commands, agents, and skills config when a Doodba project is detected.
 * Triggers auto-indexing on plugin load when in a Doodba project.
 */
export const DoodbaDevPlugin = async ({ directory }) => {
  const [
    { doodbaTools },
    { findDoodbaRoot, getSourcePaths },
    { readState },
  ] = await Promise.all([
    import(path.resolve(packageRoot, 'src/tools/index.ts')),
    import(path.resolve(packageRoot, 'src/doodba-detector.ts')),
    import(path.resolve(packageRoot, 'src/project-state.ts')),
  ])

  const doodbaRoot = findDoodbaRoot(directory)

  if (!doodbaRoot) {
    // Not a Doodba project — register tools only.
    return { tool: doodbaTools }
  }

  // Doodba project detected — trigger auto-indexing if needed
  const state = readState(doodbaRoot)
  if (state.status === 'INDEXING' && state.startedAt) {
    const stuckMs = Date.now() - new Date(state.startedAt).getTime()
    if (stuckMs > 30 * 60 * 1000) {
      // Stuck > 30 min — restart
      spawnIndexing(doodbaRoot, doodbaRoot, getSourcePaths(doodbaRoot))
    }
  } else if (state.status === 'NO_PROJECT' || state.status === 'FAILED') {
    spawnIndexing(doodbaRoot, doodbaRoot, getSourcePaths(doodbaRoot))
  }

  // Load commands and agents from the plugin package for conditional injection
  const commandsDir = path.join(packageRoot, '.opencode/commands')
  const agentsDir = path.join(packageRoot, '.opencode/agents')
  const skillsDir = path.join(packageRoot, '.opencode/skills')

  const commands = loadMarkdownDir(commandsDir, (fm, body) => {
    const cmd = { description: fm.description || '', template: body }
    if (fm.agent) cmd.agent = fm.agent
    if (fm.subtask === 'true') cmd.subtask = true
    if (fm.model) cmd.model = fm.model
    return cmd
  })

  const agents = loadMarkdownDir(agentsDir, (fm, body) => {
    const agent = { description: fm.description || '', mode: fm.mode || 'subagent', prompt: body }
    if (fm.model) agent.model = fm.model
    if (fm.temperature) agent.temperature = parseFloat(fm.temperature)
    if (fm.hidden === 'true') agent.hidden = true
    if (fm.color) agent.color = fm.color
    return agent
  })

  console.log(
    `[doodba-dev] Loaded ${Object.keys(commands).length} commands, ${Object.keys(agents).length} agents (project: ${doodbaRoot})`
  )

  return {
    tool: doodbaTools,

    config: async (config) => {
      // Inject skill discovery path
      config.skills = config.skills || {}
      config.skills.paths = config.skills.paths || []
      if (!config.skills.paths.includes(skillsDir)) {
        config.skills.paths.push(skillsDir)
      }

      // Inject commands (don't overwrite user-defined ones)
      config.command = config.command || {}
      for (const [name, cmd] of Object.entries(commands)) {
        if (!config.command[name]) config.command[name] = cmd
      }

      // Inject agents (don't overwrite user-defined ones)
      config.agent = config.agent || {}
      for (const [name, agent] of Object.entries(agents)) {
        if (!config.agent[name]) config.agent[name] = agent
      }
    },
  }
}

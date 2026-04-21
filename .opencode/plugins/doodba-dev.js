/**
 * opencode-doodba-dev plugin for OpenCode.ai
 *
 * Exports Doodba development tools. Only injects commands, agents, and skills
 * when a Doodba project is detected in the current directory tree.
 */

import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '../..')

/**
 * Simple frontmatter parser for markdown files
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { frontmatter: {}, content }

  const frontmatterStr = match[1]
  const body = match[2]
  const frontmatter = {}

  for (const line of frontmatterStr.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
      frontmatter[key] = value
    }
  }

  return { frontmatter, content: body }
}

/**
 * Discover and parse command markdown files from a directory
 */
function discoverCommands(commandsDir) {
  const commands = {}
  if (!fs.existsSync(commandsDir)) return commands

  try {
    const files = fs.readdirSync(commandsDir)
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      const filePath = path.join(commandsDir, file)
      try {
        const content = fs.readFileSync(filePath, 'utf8')
        const { frontmatter, content: body } = parseFrontmatter(content)
        const name = file.replace(/\.md$/, '')
        commands[name] = {
          description: frontmatter.description || '',
          template: body.trim(),
          agent: frontmatter.agent,
          subtask: frontmatter.subtask === 'true' ? true : undefined,
          model: frontmatter.model,
        }
        Object.keys(commands[name]).forEach(key => {
          if (commands[name][key] === undefined) delete commands[name][key]
        })
      } catch (e) {
        console.warn(`[doodba-dev] Failed to parse command ${file}:`, e.message)
      }
    }
  } catch (e) {
    console.warn(`[doodba-dev] Failed to read commands directory:`, e.message)
  }

  return commands
}

/**
 * Discover and parse agent markdown files from a directory
 */
function discoverAgents(agentsDir) {
  const agents = {}
  if (!fs.existsSync(agentsDir)) return agents

  try {
    const files = fs.readdirSync(agentsDir)
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      const filePath = path.join(agentsDir, file)
      try {
        const content = fs.readFileSync(filePath, 'utf8')
        const { frontmatter, content: body } = parseFrontmatter(content)
        const name = file.replace(/\.md$/, '')
        agents[name] = {
          description: frontmatter.description || '',
          mode: frontmatter.mode || 'subagent',
          prompt: body.trim(),
        }
        if (frontmatter.model) agents[name].model = frontmatter.model
        if (frontmatter.temperature) agents[name].temperature = parseFloat(frontmatter.temperature)
        if (frontmatter.tools) {
          try { agents[name].tools = JSON.parse(frontmatter.tools) } catch {}
        }
        if (frontmatter.permission) {
          try { agents[name].permission = JSON.parse(frontmatter.permission) } catch {}
        }
        if (frontmatter.hidden === 'true') agents[name].hidden = true
        if (frontmatter.color) agents[name].color = frontmatter.color
      } catch (e) {
        console.warn(`[doodba-dev] Failed to parse agent ${file}:`, e.message)
      }
    }
  } catch (e) {
    console.warn(`[doodba-dev] Failed to read agents directory:`, e.message)
  }

  return agents
}

/**
 * Run full Doodba indexing for a project directory.
 * Fire-and-forget: caller does not await.
 */
async function runIndexing(projectDir, doodbaRoot, { getSourcePaths, indexModules, updateState, getProjectDbPath }) {
  const sourcePaths = getSourcePaths(doodbaRoot)
  if (sourcePaths.length === 0) {
    updateState(projectDir, { status: 'FAILED', error: 'No source paths found in odoo/custom/src/' })
    return
  }
  updateState(projectDir, { status: 'INDEXING', startedAt: new Date().toISOString(), error: null })
  try {
    const result = indexModules({ rootPaths: sourcePaths, full: true, dbPath: getProjectDbPath(projectDir) })
    updateState(projectDir, {
      status: 'READY',
      completedAt: new Date().toISOString(),
      indexedFiles: result.indexed,
      missingDeps: result.missingDeps,
      error: null,
    })
  } catch (err) {
    updateState(projectDir, {
      status: 'FAILED',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * DoodbaDevPlugin - OpenCode plugin factory
 *
 * - Always registers doodba_* tools (they report NO_PROJECT gracefully when not in a Doodba project).
 * - Only injects commands, agents, and skills config when a Doodba project is detected.
 * - Triggers auto-indexing on plugin load when in a Doodba project.
 */
export const DoodbaDevPlugin = async ({ directory }) => {
  // Dynamic imports — Bun compiles .ts at runtime
  const [
    { doodbaTools },
    { findDoodbaRoot, getSourcePaths },
    { readState, updateState, getProjectDbPath },
    { indexModules },
  ] = await Promise.all([
    import(path.resolve(packageRoot, 'src/tools/index.ts')),
    import(path.resolve(packageRoot, 'src/doodba-detector.ts')),
    import(path.resolve(packageRoot, 'src/project-state.ts')),
    import(path.resolve(packageRoot, 'src/indexer.ts')),
  ])

  const doodbaRoot = findDoodbaRoot(directory)

  if (!doodbaRoot) {
    // Not a Doodba project — register tools only (they self-report NO_PROJECT)
    return { tool: doodbaTools }
  }

  // Doodba project detected — trigger auto-indexing
  const state = readState(directory)
  if (state.status === 'INDEXING' && state.startedAt) {
    const started = new Date(state.startedAt).getTime()
    if (Date.now() - started > 30 * 60 * 1000) {
      // Stuck for > 30 min — retry
      runIndexing(directory, doodbaRoot, { getSourcePaths, indexModules, updateState, getProjectDbPath })
    }
  } else if (state.status === 'NO_PROJECT' || state.status === 'FAILED') {
    // Fire-and-forget
    runIndexing(directory, doodbaRoot, { getSourcePaths, indexModules, updateState, getProjectDbPath })
  }

  // Discover commands and agents from package
  const skillsDir = path.join(packageRoot, '.opencode/skills')
  const commandsDir = path.join(packageRoot, '.opencode/commands')
  const agentsDir = path.join(packageRoot, '.opencode/agents')
  const commands = discoverCommands(commandsDir)
  const agents = discoverAgents(agentsDir)

  return {
    tool: doodbaTools,

    config: async (config) => {
      // Inject skills path
      config.skills = config.skills || {}
      config.skills.paths = config.skills.paths || []
      if (!config.skills.paths.includes(skillsDir)) {
        config.skills.paths.push(skillsDir)
      }

      // Inject commands
      config.command = config.command || {}
      for (const [name, cmd] of Object.entries(commands)) {
        if (!config.command[name]) config.command[name] = cmd
      }

      // Inject agents
      config.agent = config.agent || {}
      for (const [name, agent] of Object.entries(agents)) {
        if (!config.agent[name]) config.agent[name] = agent
      }

      console.log(
        `[doodba-dev] Loaded ${Object.keys(commands).length} commands, ${Object.keys(agents).length} agents (project: ${doodbaRoot})`
      )
    },
  }
}

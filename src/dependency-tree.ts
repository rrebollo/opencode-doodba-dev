import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parseManifest } from "./parsers/manifest"

export interface ModuleNode {
  name: string
  path: string
  depends: string[]
  depth: number
}

export interface CycleDetectionResult {
  hasCycles: boolean
  cycles: string[][]
}

export function discoverModules(rootPaths: string[]): Map<string, ModuleNode> {
  const modules = new Map<string, ModuleNode>()

  for (const rootPath of rootPaths) {
    if (!existsSync(rootPath)) continue

    // Determine candidate directories to scan for modules
    const candidates: string[] = []

    // Odoo core repository structure: addons live in odoo/addons/ or addons/
    const odooAddonsPath = join(rootPath, "odoo", "addons")
    const addonsPath = join(rootPath, "addons")
    if (existsSync(odooAddonsPath)) {
      candidates.push(odooAddonsPath)
    }
    if (existsSync(addonsPath)) {
      candidates.push(addonsPath)
    }

    // Normal repository: addons live directly at root
    if (candidates.length === 0) {
      candidates.push(rootPath)
    }

    for (const candidate of candidates) {
      try {
        for (const entry of readdirSync(candidate, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const modulePath = join(candidate, entry.name)
          const manifestPath = join(modulePath, "__manifest__.py")
          if (!existsSync(manifestPath)) continue
          const manifest = parseManifest(manifestPath, entry.name)
          modules.set(entry.name, {
            name: entry.name,
            path: modulePath,
            depends: manifest.depends,
            depth: 0,
          })
        }
      } catch (err) {
        console.warn("[dependency-tree] Error discovering modules:", err)
      }
    }
  }

  return modules
}

export function findCycles(modules: Map<string, ModuleNode>): CycleDetectionResult {
  const visited = new Set<string>()
  const recursionStack = new Set<string>()
  const cycles: string[][] = []
  const path: string[] = []

  function visit(node: string): void {
    if (recursionStack.has(node)) {
      // Found a cycle
      const cycleStart = path.indexOf(node)
      if (cycleStart !== -1) {
        const cycle = path.slice(cycleStart).concat([node])
        cycles.push(cycle)
      }
      return
    }

    if (visited.has(node)) return

    visited.add(node)
    recursionStack.add(node)
    path.push(node)

    const nodeObj = modules.get(node)
    if (nodeObj) {
      for (const dep of nodeObj.depends) {
        visit(dep)
      }
    }

    path.pop()
    recursionStack.delete(node)
  }

  for (const moduleName of modules.keys()) {
    if (!visited.has(moduleName)) {
      visit(moduleName)
    }
  }

  return {
    hasCycles: cycles.length > 0,
    cycles,
  }
}

export function resolveDependencyOrder(modules: Map<string, ModuleNode>): ModuleNode[] {
  // Calculate depth for each module: max depth of its dependencies + 1
  const depthMap = new Map<string, number>()
  
  function calculateDepth(name: string): number {
    if (depthMap.has(name)) return depthMap.get(name)!
    
    const node = modules.get(name)
    if (!node) return 0
    
    if (node.depends.length === 0) {
      depthMap.set(name, 0)
      return 0
    }
    
    const maxDepOfDeps = Math.max(...node.depends.map(dep => calculateDepth(dep)))
    const depth = maxDepOfDeps + 1
    depthMap.set(name, depth)
    return depth
  }
  
  // Calculate depths for all modules
  for (const name of modules.keys()) {
    calculateDepth(name)
  }
  
  // Apply calculated depths and perform topological sort
  const visited = new Set<string>()
  const order: ModuleNode[] = []

  function visit(name: string): void {
    if (visited.has(name)) return
    visited.add(name)
    
    const node = modules.get(name)
    if (!node) return
    
    node.depth = depthMap.get(name) || 0
    
    for (const dep of node.depends) {
      visit(dep)
    }
    order.push(node)
  }

  for (const name of modules.keys()) visit(name)
  return order
}

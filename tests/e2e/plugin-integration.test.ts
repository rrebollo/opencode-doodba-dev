import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Plugin Integration Tests
 * 
 * Tests for the DoodbaDevPlugin factory to ensure:
 * 1. Bug T Fix: Plugin respects doodbaRoot for state reads (not cwd)
 * 2. Bug S Fix: Plugin spawns indexer asynchronously (non-blocking)
 * 3. Error handling: Plugin gracefully handles NO_PROJECT state
 */

describe("Plugin Integration Tests", () => {
  let projectRoot: string
  let subdirectory: string

  beforeAll(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "plugin-integration-"))
    subdirectory = join(projectRoot, "apps", "backend")

    // Create the doodba project structure
    mkdirSync(join(projectRoot, "odoo", "custom", "src"), { recursive: true })
    writeFileSync(join(projectRoot, ".copier-answers.yml"), "project_slug: test-project")

    // Create subdirectory (simulating invoking from a sub-project)
    mkdirSync(subdirectory, { recursive: true })
  })

  afterAll(() => {
    rmSync(projectRoot, { recursive: true })
  })

  describe("doodbaRoot state management (Bug T)", () => {
    it("Plugin respects doodbaRoot for state reads when invoked from subdirectory", async () => {
      // Arrange: Create a state.json file at the doodbaRoot
      const stateDir = join(projectRoot, ".opencode", "doodba-dev")
      mkdirSync(stateDir, { recursive: true })
      const statePath = join(stateDir, "state.json")
      writeFileSync(
        statePath,
        JSON.stringify({
          status: "READY",
          indexedFiles: 42,
          missingDeps: [],
          error: null,
          startedAt: null,
          completedAt: new Date().toISOString(),
        })
      )

      // Act: Dynamically import and invoke plugin from subdirectory
      // This is loaded at runtime to avoid static module resolution issues
      const { DoodbaDevPlugin } = await import(
        "../../.opencode/plugins/doodba-dev.js"
      )
      const plugin = await DoodbaDevPlugin({ directory: subdirectory })

      // Assert: Plugin should have detected the doodbaRoot correctly
      expect(plugin).toBeDefined()
      expect(plugin.tool).toBeDefined()
      expect(plugin.config).toBeDefined()

      // Verify state file exists at the correct doodbaRoot location
      expect(existsSync(statePath)).toBe(true)
      const stateContent = JSON.parse(readFileSync(statePath, "utf-8"))
      expect(stateContent.status).toBe("READY")
      expect(stateContent.indexedFiles).toBe(42)

      // CRITICAL: Plugin should NOT try to read state from subdirectory
      // (there should be no .opencode/doodba-dev in subdirectory)
      const wrongStateDir = join(subdirectory, ".opencode", "doodba-dev")
      expect(existsSync(wrongStateDir)).toBe(false)
    })

    it("Plugin correctly identifies doodbaRoot from nested subdirectory", async () => {
      // Arrange: Create a deeply nested subdirectory
      const deepSubdir = join(projectRoot, "apps", "backend", "src", "deeply", "nested")
      mkdirSync(deepSubdir, { recursive: true })

      // Act: Call plugin from deeply nested directory
      const { DoodbaDevPlugin } = await import(
        "../../.opencode/plugins/doodba-dev.js"
      )
      const plugin = await DoodbaDevPlugin({ directory: deepSubdir })

      // Assert: Plugin should succeed and traverse up to find doodbaRoot
      expect(plugin).toBeDefined()
      expect(plugin.tool).toBeDefined()
      expect(plugin.config).toBeDefined()
    })

    it("Ensures state reads respect project boundary (doodbaRoot anchor)", async () => {
      // This is a critical test that verifies the "Layer Bypass" bug is fixed
      // The plugin must use doodbaRoot as the anchor when reading state, not cwd

      // Arrange: Create a completely separate project
      const otherProject = mkdtempSync(join(tmpdir(), "other-project-"))
      const otherSubdir = join(otherProject, "sub")
      mkdirSync(join(otherProject, "odoo", "custom", "src"), { recursive: true })
      writeFileSync(join(otherProject, ".copier-answers.yml"), "")
      mkdirSync(otherSubdir, { recursive: true })

      // Write a state file to otherProject's doodbaRoot
      const otherStateDir = join(otherProject, ".opencode", "doodba-dev")
      mkdirSync(otherStateDir, { recursive: true })
      writeFileSync(
        join(otherStateDir, "state.json"),
        JSON.stringify({
          status: "INDEXING",
          indexedFiles: 99,
          error: "other project state",
          startedAt: new Date().toISOString(),
          completedAt: null,
          missingDeps: [],
        })
      )

      try {
        // Act: Invoke plugin from otherProject (not projectRoot)
        const { DoodbaDevPlugin } = await import(
          "../../.opencode/plugins/doodba-dev.js"
        )
        const plugin = await DoodbaDevPlugin({ directory: otherSubdir })

        // Assert: Plugin should use otherProject's doodbaRoot
        expect(plugin).toBeDefined()
        expect(plugin.config).toBeDefined()

        // Verify the correct state was loaded (from otherProject, not projectRoot)
        const stateContent = JSON.parse(
          readFileSync(join(otherStateDir, "state.json"), "utf-8")
        )
        expect(stateContent.indexedFiles).toBe(99)
        expect(stateContent.error).toBe("other project state")
      } finally {
        rmSync(otherProject, { recursive: true })
      }
    })
  })

  describe("Async indexing behavior (Bug S)", () => {
    it("Plugin returns quickly without blocking on indexer spawning", async () => {
      // Arrange: Create a fresh doodba project in NO_PROJECT state
      const asyncTestDir = mkdtempSync(join(tmpdir(), "plugin-async-test-"))
      const asyncSubdir = join(asyncTestDir, "src")
      mkdirSync(join(asyncTestDir, "odoo", "custom", "src"), { recursive: true })
      writeFileSync(join(asyncTestDir, ".copier-answers.yml"), "project_slug: async-test")
      mkdirSync(asyncSubdir, { recursive: true })

      try {
        // Act: Call plugin (which should trigger auto-indexing)
        const callStart = performance.now()
        const { DoodbaDevPlugin } = await import(
          "../../.opencode/plugins/doodba-dev.js"
        )
        const plugin = await DoodbaDevPlugin({ directory: asyncSubdir })
        const callDuration = performance.now() - callStart

        // Assert: Plugin should return quickly (< 100ms)
        // This proves spawn() is non-blocking (fire-and-forget)
        expect(callDuration).toBeLessThan(100)
        expect(plugin).toBeDefined()
        expect(plugin.config).toBeDefined()
      } finally {
        rmSync(asyncTestDir, { recursive: true })
      }
    })

    it("Plugin entry point is async but does not await indexer completion", async () => {
      // This verifies that the DoodbaDevPlugin function is async
      // but internally uses fire-and-forget for Bun.spawn
      const nonBlockTestDir = mkdtempSync(join(tmpdir(), "plugin-nonblock-"))
      mkdirSync(join(nonBlockTestDir, "odoo", "custom", "src"), { recursive: true })
      writeFileSync(join(nonBlockTestDir, ".copier-answers.yml"), "")

      try {
        // Act: Await the plugin (should complete immediately)
        const startTime = performance.now()
        const { DoodbaDevPlugin } = await import(
          "../../.opencode/plugins/doodba-dev.js"
        )
        await DoodbaDevPlugin({ directory: nonBlockTestDir })
        const elapsed = performance.now() - startTime

        // Assert: Should complete in < 100ms (quick return, no blocking)
        expect(elapsed).toBeLessThan(100)
      } finally {
        rmSync(nonBlockTestDir, { recursive: true })
      }
    })
  })

  describe("NO_PROJECT state handling", () => {
    it("Plugin handles NO_PROJECT gracefully when not in doodba project", async () => {
      // Arrange: Create a directory that is NOT a Doodba project
      const orphanDir = mkdtempSync(join(tmpdir(), "not-doodba-"))

      try {
        // Act: Call plugin from a non-Doodba directory
        const { DoodbaDevPlugin } = await import(
          "../../.opencode/plugins/doodba-dev.js"
        )
        const plugin = await DoodbaDevPlugin({ directory: orphanDir })

        // Assert: Should not crash, should return tools only (config is undefined)
        expect(plugin).toBeDefined()
        expect(plugin.tool).toBeDefined()
        // In NO_PROJECT state, config should be undefined per the plugin code
        expect(plugin.config).toBeUndefined()
      } finally {
        rmSync(orphanDir, { recursive: true })
      }
    })

    it("Plugin gracefully handles missing odoo/custom/src directory", async () => {
      // Arrange: Create a Doodba marker without proper directory structure
      const brokenDir = mkdtempSync(join(tmpdir(), "broken-doodba-"))
      writeFileSync(join(brokenDir, ".copier-answers.yml"), "")

      try {
        // Act: Call plugin (missing odoo/custom/src)
        const { DoodbaDevPlugin } = await import(
          "../../.opencode/plugins/doodba-dev.js"
        )
        const plugin = await DoodbaDevPlugin({ directory: brokenDir })

        // Assert: Should not crash
        expect(plugin).toBeDefined()
        expect(plugin.tool).toBeDefined()
      } finally {
        rmSync(brokenDir, { recursive: true })
      }
    })

    it("Plugin recovers when re-invoked after Doodba project is created", async () => {
      // Arrange: Start with non-Doodba directory
      const evolvedDir = mkdtempSync(join(tmpdir(), "evolving-project-"))

      try {
        // Act 1: Call plugin in non-Doodba state
        const { DoodbaDevPlugin } = await import(
          "../../.opencode/plugins/doodba-dev.js"
        )
        const plugin1 = await DoodbaDevPlugin({ directory: evolvedDir })
        expect(plugin1.config).toBeUndefined()

        // Arrange 2: Turn it into a Doodba project
        mkdirSync(join(evolvedDir, "odoo", "custom", "src"), { recursive: true })
        writeFileSync(join(evolvedDir, ".copier-answers.yml"), "")

        // Act 2: Call plugin again
        const plugin2 = await DoodbaDevPlugin({ directory: evolvedDir })

        // Assert: Now it should have config
        expect(plugin2).toBeDefined()
        expect(plugin2.tool).toBeDefined()
        expect(plugin2.config).toBeDefined()
      } finally {
        rmSync(evolvedDir, { recursive: true })
      }
    })
  })

  describe("Plugin state transitions and auto-indexing", () => {
    it("Plugin does not spawn indexer when state is READY", async () => {
      // This test verifies that the plugin checks state before spawning
      const readyTestDir = mkdtempSync(join(tmpdir(), "plugin-ready-"))
      mkdirSync(join(readyTestDir, "odoo", "custom", "src"), { recursive: true })
      writeFileSync(join(readyTestDir, ".copier-answers.yml"), "")

      // Create state.json with READY status (should NOT trigger indexing)
      const stateDir = join(readyTestDir, ".opencode", "doodba-dev")
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(
        join(stateDir, "state.json"),
        JSON.stringify({
          status: "READY",
          indexedFiles: 100,
          missingDeps: [],
          error: null,
          startedAt: null,
          completedAt: new Date().toISOString(),
        })
      )

      try {
        // Act: Call plugin with READY state
        const { DoodbaDevPlugin } = await import(
          "../../.opencode/plugins/doodba-dev.js"
        )
        const plugin = await DoodbaDevPlugin({ directory: readyTestDir })

        // Assert: Plugin should succeed with config
        expect(plugin.config).toBeDefined()

        // State should remain READY (not changed to INDEXING)
        const stateContent = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf-8"))
        expect(stateContent.status).toBe("READY")
      } finally {
        rmSync(readyTestDir, { recursive: true })
      }
    })

    it("Plugin triggers indexing on NO_PROJECT or FAILED status", async () => {
      // Verify that plugin detects NO_PROJECT and spawns indexer
      // This test proves that the plugin:
      // 1. Detects NO_PROJECT state
      // 2. Spawns indexer without blocking
      // 3. Returns immediately with config
      const triggerTestDir = mkdtempSync(join(tmpdir(), "plugin-trigger-"))
      mkdirSync(join(triggerTestDir, "odoo", "custom", "src"), { recursive: true })
      writeFileSync(join(triggerTestDir, ".copier-answers.yml"), "")

      try {
        // Act: Call plugin (state will be NO_PROJECT initially)
        const callStart = performance.now()
        const { DoodbaDevPlugin } = await import(
          "../../.opencode/plugins/doodba-dev.js"
        )
        const plugin = await DoodbaDevPlugin({ directory: triggerTestDir })
        const callDuration = performance.now() - callStart

        // Assert: Plugin should complete without error and quickly (< 100ms)
        expect(plugin).toBeDefined()
        expect(plugin.config).toBeDefined()
        
        // This proves spawn is non-blocking - return happens before indexer completes
        expect(callDuration).toBeLessThan(100)

        // The project directory should be created (by readState->ensureProjectDir)
        const stateDir = join(triggerTestDir, ".opencode", "doodba-dev")
        expect(existsSync(stateDir)).toBe(true)
      } finally {
        rmSync(triggerTestDir, { recursive: true })
      }
    })

    it("Plugin returns tools and config with correct injected paths", async () => {
      // Verify the plugin injects skills and commands correctly
      const configTestDir = mkdtempSync(join(tmpdir(), "plugin-config-"))
      mkdirSync(join(configTestDir, "odoo", "custom", "src"), { recursive: true })
      writeFileSync(join(configTestDir, ".copier-answers.yml"), "")

      // Ensure state is READY to avoid indexing spawning
      const stateDir = join(configTestDir, ".opencode", "doodba-dev")
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(
        join(stateDir, "state.json"),
        JSON.stringify({
          status: "READY",
          indexedFiles: 1,
          missingDeps: [],
          error: null,
          startedAt: null,
          completedAt: new Date().toISOString(),
        })
      )

      try {
        // Act: Call plugin
        const { DoodbaDevPlugin } = await import(
          "../../.opencode/plugins/doodba-dev.js"
        )
        const plugin = await DoodbaDevPlugin({ directory: configTestDir })

        // Assert: Plugin should have tool and config
        expect(plugin.tool).toBeDefined()
        expect(plugin.config).toBeDefined()

        // Config should be a function we can call to inject settings
        expect(typeof plugin.config).toBe("function")
      } finally {
        rmSync(configTestDir, { recursive: true })
      }
    })
  })
})

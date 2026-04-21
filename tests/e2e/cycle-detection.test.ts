import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { indexModules } from "../../src/indexer"

describe("cycle detection during indexing", () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "doodba-cycles-"))

    // Create two modules that depend on each other (A -> B -> A)
    for (const [name, deps] of [["mod_a", ["mod_b"]], ["mod_b", ["mod_a"]]] as const) {
      const modDir = join(tmpDir, name)
      mkdirSync(join(modDir, "models"), { recursive: true })
      writeFileSync(
        join(modDir, "__manifest__.py"),
        `{"name": "${name}", "depends": ${JSON.stringify(deps)}}`,
      )
      writeFileSync(
        join(modDir, "models", "model.py"),
        `from odoo import models, fields\nclass M(models.Model):\n    _name = "${name}.model"\n    x = fields.Char()\n`,
      )
    }
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true })
  })

  it("emits a warning when cyclic dependencies are detected", () => {
    const warns: string[] = []
    const spy = spyOn(console, "warn").mockImplementation((...args) => {
      warns.push(args.join(" "))
    })

    const dbDir = join(tmpDir, ".opencode", "doodba-dev")
    mkdirSync(dbDir, { recursive: true })
    const dbPath = join(dbDir, "index.db")

    indexModules({ rootPaths: [tmpDir], full: true, dbPath })

    spy.mockRestore()

    const cycleWarn = warns.find((w) => w.toLowerCase().includes("cycl"))
    expect(cycleWarn).toBeDefined()
  })

  it("does not crash when cyclic dependencies exist", () => {
    const dbDir = join(tmpDir, ".opencode", "doodba-dev2")
    mkdirSync(dbDir, { recursive: true })
    const dbPath = join(dbDir, "index.db")

    // Should not throw
    expect(() => {
      indexModules({ rootPaths: [tmpDir], full: true, dbPath })
    }).not.toThrow()
  })
})

import { describe, expect, test } from "bun:test"
import { findDoodbaRoot, getSourcePaths } from "../../src/doodba-detector"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const TMP = join(tmpdir(), `doodba-detector-test-${Date.now()}`)

function setup() {
  mkdirSync(TMP, { recursive: true })
  return TMP
}

function teardown() {
  rmSync(TMP, { recursive: true, force: true })
}

describe("findDoodbaRoot", () => {
  test("returns null when marker is not found within MAX_WALK_DEPTH", () => {
    const deep = join(TMP, "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u")
    mkdirSync(deep, { recursive: true })
    const result = findDoodbaRoot(deep)
    expect(result).toBeNull()
    teardown()
  })

  test("finds root at ancestor directory", () => {
    const root = join(TMP, "project")
    const subDir = join(root, "src", "modules")
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(root, ".copier-answers.yml"), "")
    const result = findDoodbaRoot(subDir)
    expect(result).toBe(root)
    teardown()
  })
})

describe("getSourcePaths", () => {
  test("excludes hidden directories", () => {
    const root = join(TMP, "doodba")
    const srcDir = join(root, "odoo", "custom", "src")
    mkdirSync(join(srcDir, ".git"), { recursive: true })
    mkdirSync(join(srcDir, "my_module"), { recursive: true })
    writeFileSync(join(srcDir, "my_module", "__manifest__.py"), "")
    const paths = getSourcePaths(root)
    expect(paths.every((p) => !p.includes("/.git"))).toBe(true)
    teardown()
  })

  test("only returns directories containing __manifest__.py", () => {
    const root = join(TMP, "doodba2")
    const srcDir = join(root, "odoo", "custom", "src")
    mkdirSync(join(srcDir, "real_module"), { recursive: true })
    writeFileSync(join(srcDir, "real_module", "__manifest__.py"), "")
    mkdirSync(join(srcDir, "not_a_module"), { recursive: true })
    const paths = getSourcePaths(root)
    expect(paths).toHaveLength(1)
    expect(paths[0]).toContain("real_module")
    teardown()
  })
})

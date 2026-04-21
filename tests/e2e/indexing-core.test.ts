import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { discoverModules, resolveDependencyOrder } from "../../src/dependency-tree"
import { createTestFixture, destroyTestFixture, type TestFixture } from "./setup"

describe("indexing - core addons", () => {
  let fixture: TestFixture

  beforeAll(() => {
    fixture = createTestFixture()
  })

  afterAll(() => {
    destroyTestFixture(fixture)
  })

  it("discovers base addon inside odoo/odoo/addons/", () => {
    const modules = discoverModules(fixture.sourcePaths)
    expect(modules.has("base")).toBe(true)
    expect(modules.get("base")?.path).toContain("odoo/odoo/addons/base")
    expect(modules.get("base")?.depends).toEqual([])
  })

  it("discovers sale addon inside addons/", () => {
    const modules = discoverModules(fixture.sourcePaths)
    expect(modules.has("sale")).toBe(true)
    expect(modules.get("sale")?.path).toContain("addons/sale")
    expect(modules.get("sale")?.depends).toEqual(["base"])
  })

  it("orders dependencies correctly (base before sale)", () => {
    const modules = discoverModules(fixture.sourcePaths)
    const ordered = resolveDependencyOrder(modules)
    const names = ordered.map((m) => m.name)

    const baseIndex = names.indexOf("base")
    const saleIndex = names.indexOf("sale")

    expect(baseIndex).toBeGreaterThan(-1)
    expect(saleIndex).toBeGreaterThan(-1)
    expect(baseIndex).toBeLessThan(saleIndex)
  })
})

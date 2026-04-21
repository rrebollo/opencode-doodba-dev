import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { indexModules } from "../../src/indexer"
import { DoodbaIndexDatabase } from "../../src/database"
import { createTestFixture, destroyTestFixture, type TestFixture } from "./setup"

describe("full indexing workflow", () => {
  let fixture: TestFixture

  beforeAll(() => {
    fixture = createTestFixture()
  })

  afterAll(() => {
    destroyTestFixture(fixture)
  })

  it("indexes all modules without errors", () => {
    const result = indexModules({
      rootPaths: fixture.sourcePaths,
      full: true,
      dbPath: fixture.dbPath,
    })

    expect(result.errors).toBe(0)
    expect(result.indexed).toBeGreaterThan(0)
    // Should have indexed: base(3) + sale(3) + partner_firstname(1) + my_module(3)
    expect(result.indexed).toBeGreaterThanOrEqual(4)
  })

  it("creates queryable database entries", () => {
    indexModules({
      rootPaths: fixture.sourcePaths,
      full: true,
      dbPath: fixture.dbPath,
    })

    const db = new DoodbaIndexDatabase(fixture.dbPath)
    try {
      // Search for a model
      const models = db.search({ query: "res.partner", itemType: "model" })
      expect(models.length).toBeGreaterThan(0)
      expect(models.some((m) => m.name === "res.partner")).toBe(true)

      // Search for a field
      const fields = db.search({ query: "email", itemType: "field", parentName: "res.partner" })
      expect(fields.length).toBeGreaterThan(0)

      // Search for sale.order model
      const orders = db.search({ query: "sale.order", itemType: "model" })
      expect(orders.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it("indexes cross-repo dependencies correctly", () => {
    indexModules({
      rootPaths: fixture.sourcePaths,
      full: true,
      dbPath: fixture.dbPath,
    })

    const db = new DoodbaIndexDatabase(fixture.dbPath)
    try {
      // my_module should be indexed
      const myModule = db.search({ query: "my.model", itemType: "model" })
      expect(myModule.length).toBeGreaterThan(0)

      // my_module's field referencing sale.order should exist
      const fields = db.search({ query: "order_id", itemType: "field", parentName: "my.model" })
      expect(fields.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })
})

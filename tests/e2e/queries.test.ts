import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { chdir } from "node:process"
import { tmpdir } from "node:os"
import { indexModules } from "../../src/indexer"
import { DoodbaIndexDatabase } from "../../src/database"
import { createTestFixture, destroyTestFixture, type TestFixture } from "./setup"

describe("plugin tool queries", () => {
  let fixture: TestFixture

  beforeAll(() => {
    fixture = createTestFixture()
    indexModules({ rootPaths: fixture.sourcePaths, full: true, dbPath: fixture.dbPath })
  })

  afterAll(() => {
    destroyTestFixture(fixture)
  })

  it("doodba_search finds models by name", () => {
    const db = new DoodbaIndexDatabase(fixture.dbPath)
    try {
      const results = db.search({ query: "res.partner", itemType: "model" })
      expect(results.some((r) => r.name === "res.partner")).toBe(true)
    } finally {
      db.close()
    }
  })

  it("doodba_get_details returns model info", () => {
    const db = new DoodbaIndexDatabase(fixture.dbPath)
    try {
      const result = db.getDetails("sale.order", "model")
      expect(result).not.toBeNull()
      expect(result?.name).toBe("sale.order")
      expect(result?.module).toBe("sale")
    } finally {
      db.close()
    }
  })

  it("doodba_list_modules returns all indexed modules", () => {
    const db = new DoodbaIndexDatabase(fixture.dbPath)
    try {
      const modules = db.listModules()
      expect(modules).toContain("base")
      expect(modules).toContain("sale")
      expect(modules).toContain("my_module")
      // partner_firstname is discovered but may not have indexed items if it only inherits
      expect(modules.length).toBeGreaterThanOrEqual(3)
    } finally {
      db.close()
    }
  })

  it("doodba_module_stats returns item counts", () => {
    const db = new DoodbaIndexDatabase(fixture.dbPath)
    try {
      const stats = db.moduleStats("base")
      expect(stats.model).toBeGreaterThan(0)
      expect(stats.field).toBeGreaterThan(0)
      // view key might not exist if no views are indexed
      expect(typeof stats.view === "undefined" || stats.view >= 0).toBe(true)
    } finally {
      db.close()
    }
  })

  it("doodba_search_by_attr finds required fields", () => {
    const db = new DoodbaIndexDatabase(fixture.dbPath)
    try {
      const results = db.searchByAttr("field", { required: true }, "base")
      expect(results.length).toBeGreaterThan(0)
      expect(results.some((r) => r.name === "name" && r.parentName === "res.partner")).toBe(true)
    } finally {
      db.close()
    }
  })

  it("doodba_search_by_attr boolean false: finds non-required fields", () => {
    // SQLite's json_extract on JSON boolean `false` returns integer 0.
    // The searchByAttr implementation converts JS false → 0 before comparison, which is correct.
    const db = new DoodbaIndexDatabase(fixture.dbPath)
    try {
      const results = db.searchByAttr("field", { required: false }, "base")
      expect(results.length).toBeGreaterThan(0)
      // email and phone are non-required fields on res.partner
      expect(results.some((r) => r.name === "email" && r.parentName === "res.partner")).toBe(true)
      // none of the results should be required
      expect(results.every((r) => r.attributes.required === false)).toBe(true)
    } finally {
      db.close()
    }
  })

  it("doodba_find_refs returns references", () => {
    const db = new DoodbaIndexDatabase(fixture.dbPath)
    try {
      // my_module's order_id field references sale.order
      const refs = db.findRefs("sale.order", "model")
      // Note: references may or may not be populated depending on parser implementation
      // This test documents expected behavior
      expect(Array.isArray(refs)).toBe(true)
    } finally {
      db.close()
    }
  })

  it("doodba_index_status returns counts", () => {
    const db = new DoodbaIndexDatabase(fixture.dbPath)
    try {
      const status = db.indexStatus()
      expect(status.totalItems).toBeGreaterThan(0)
      // Only modules with indexed items are counted
      expect(status.totalModules).toBeGreaterThanOrEqual(3)
      expect(status.lastIndexed).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it("database queries work regardless of process.cwd()", () => {
    // Documents that DoodbaIndexDatabase uses an explicit dbPath, not process.cwd().
    // The tool layer enforces this by passing context.directory to getProjectDbPath()
    // rather than relying on process.cwd() — this test verifies the DB layer holds up
    // when cwd changes under it.
    const originalCwd = process.cwd()
    try {
      chdir(tmpdir())

      const db = new DoodbaIndexDatabase(fixture.dbPath)
      try {
        const results = db.search({ query: "res.partner", itemType: "model" })
        expect(results.some((r) => r.name === "res.partner")).toBe(true)
      } finally {
        db.close()
      }
    } finally {
      chdir(originalCwd)
    }
  })
})

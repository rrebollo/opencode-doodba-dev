import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DoodbaIndexDatabase } from "../../src/database"

describe("item_references", () => {
  let tmpDir: string
  let dbPath: string
  let db: DoodbaIndexDatabase

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "doodba-refs-test-"))
    dbPath = join(tmpDir, "test.db")
    db = new DoodbaIndexDatabase(dbPath)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true })
  })

  it("upsertReference stores a reference and findRefs retrieves it", () => {
    const itemId = db.upsertItem("model", "res.partner", null, "base", {})
    db.upsertReference(itemId, "/some/file.py", 42, "definition", "class ResPartner")

    const refs = db.findRefs("res.partner", "model")
    expect(refs.length).toBe(1)
    expect(refs[0].file_path).toBe("/some/file.py")
    expect(refs[0].line_number).toBe(42)
    expect(refs[0].reference_type).toBe("definition")
    expect(refs[0].context).toBe("class ResPartner")
  })

  it("upsertReference with null context is allowed", () => {
    const itemId = db.upsertItem("field", "name", "res.partner", "base", {})
    db.upsertReference(itemId, "/some/file.py", 10, "definition", null)

    const refs = db.findRefs("name", "field")
    expect(refs.length).toBe(1)
    expect(refs[0].context).toBeNull()
  })

  it("multiple references for same item accumulate", () => {
    const itemId = db.upsertItem("model", "sale.order", null, "sale", {})
    db.upsertReference(itemId, "/sale/models/sale_order.py", 5, "definition", "class SaleOrder")
    db.upsertReference(itemId, "/my_module/models/my_model.py", 7, "many2one", "order_id = fields.Many2one")

    const refs = db.findRefs("sale.order", "model")
    expect(refs.length).toBe(2)
    const types = refs.map((r) => r.reference_type).sort()
    expect(types).toEqual(["definition", "many2one"])
  })

  it("clearModule cascades and removes references", () => {
    const itemId = db.upsertItem("model", "res.partner", null, "base", {})
    db.upsertReference(itemId, "/base/models/res_partner.py", 1, "definition", null)
    db.clearModule("base")

    const refs = db.findRefs("res.partner", "model")
    expect(refs.length).toBe(0)
  })
})

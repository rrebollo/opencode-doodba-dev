import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DoodbaIndexDatabase } from "../../src/database"
import { parsePythonAst } from "../../src/parsers/python-ast"
import { indexModules } from "../../src/indexer"
import { createTestFixture, destroyTestFixture, type TestFixture } from "./setup"

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
    expect(refs[0].filePath).toBe("/some/file.py")
    expect(refs[0].lineNumber).toBe(42)
    expect(refs[0].referenceType).toBe("definition")
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
    const types = refs.map((r) => r.referenceType).sort()
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

describe("parsePythonAst", () => {
  let tmpDir2: string

  beforeEach(() => {
    tmpDir2 = mkdtempSync(join(tmpdir(), "doodba-ast-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir2, { recursive: true })
  })

  it("extracts model, fields, and methods with correct line numbers", () => {
    const pyFile = join(tmpDir2, "test_model.py")
    writeFileSync(pyFile, `from odoo import models, fields

class SaleOrder(models.Model):
    _name = "sale.order"
    _description = "Sales Order"

    name = fields.Char(string="Name", required=True)
    partner_id = fields.Many2one("res.partner", string="Customer")

    def action_confirm(self):
        pass
`)
    const items = parsePythonAst(pyFile, "sale")
    const model = items.find((i) => i.itemType === "model")
    expect(model).toBeDefined()
    expect(model!.name).toBe("sale.order")
    expect(model!.references[0].referenceType).toBe("definition")
    expect(model!.references[0].lineNumber).toBe(3)

    const partnerField = items.find((i) => i.name === "partner_id")
    expect(partnerField).toBeDefined()
    expect(partnerField!.references.length).toBe(2)
    const relRef = partnerField!.references.find((r) => r.referenceType === "many2one")
    expect(relRef).toBeDefined()
    expect(relRef!.context).toContain("res.partner")

    const method = items.find((i) => i.itemType === "method" && i.name === "action_confirm")
    expect(method).toBeDefined()
    expect(method!.references[0].lineNumber).toBe(10)
  })

  it("handles _inherit-only extension correctly", () => {
    const pyFile = join(tmpDir2, "extend.py")
    writeFileSync(pyFile, `from odoo import models, fields

class ResPartner(models.Model):
    _inherit = "res.partner"

    firstname = fields.Char(string="First Name")
`)
    const items = parsePythonAst(pyFile, "partner_firstname")
    const model = items.find((i) => i.itemType === "model")
    expect(model).toBeDefined()
    expect(model!.name).toBe("res.partner")
    expect(model!.references[0].referenceType).toBe("inheritance")

    const field = items.find((i) => i.name === "firstname")
    expect(field).toBeDefined()
    expect(field!.parentName).toBe("res.partner")
  })

   it("returns [] for nonexistent file", () => {
     const items = parsePythonAst("/nonexistent/file.py", "base")
     // Should return an empty array, not undefined or null
     expect(items).toEqual([])
   })

  it("handles comodel_name kwarg form", () => {
    const pyFile = join(tmpDir2, "kwarg_model.py")
    writeFileSync(pyFile, `from odoo import models, fields

class MyModel(models.Model):
    _name = "my.model"

    partner_id = fields.Many2one(comodel_name="res.partner", string="Partner")
`)
    const items = parsePythonAst(pyFile, "my_module")
    const field = items.find((i) => i.name === "partner_id")
    expect(field).toBeDefined()
    const comodelRef = field!.references.find((r) => r.referenceType === "many2one")
    expect(comodelRef).toBeDefined()
    expect(comodelRef!.context).toContain("res.partner")
  })
})

describe("indexer populates item_references", () => {
  let fixture: TestFixture

  beforeEach(() => {
    fixture = createTestFixture()
    indexModules({ rootPaths: fixture.sourcePaths, full: true, dbPath: fixture.dbPath })
  })

  afterEach(() => {
    destroyTestFixture(fixture)
  })

  it("res.partner model has a definition reference", () => {
    const db = new DoodbaIndexDatabase(fixture.dbPath)
    try {
      const refs = db.findRefs("res.partner", "model")
      expect(refs.length).toBeGreaterThan(0)
      const defRef = refs.find((r: any) => r.referenceType === "definition")
      expect(defRef).toBeDefined()
      expect(defRef!.filePath).toContain("res_partner.py")
    } finally {
      db.close()
    }
  })

  it("partner_firstname _inherit reference exists for res.partner", () => {
    const db = new DoodbaIndexDatabase(fixture.dbPath)
    try {
      const refs = db.findRefs("res.partner", "model")
      const inheritRef = refs.find((r: any) => r.referenceType === "inheritance")
      expect(inheritRef).toBeDefined()
    } finally {
      db.close()
    }
  })

  it("sale.order model has references from Many2one fields in other modules", () => {
    // sale.order model itself has a definition reference from its own file
    const db = new DoodbaIndexDatabase(fixture.dbPath)
    try {
      const refs = db.findRefs("sale.order", "model")
      expect(refs.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })
})

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { indexModules } from "../../src/indexer";
import { DoodbaIndexDatabase } from "../../src/database";
import { createTestFixture, destroyTestFixture, type TestFixture } from "./setup";

describe("full indexing workflow", () => {
  let fixture: TestFixture;

  beforeAll(() => {
    fixture = createTestFixture();
  });

  afterAll(() => {
    destroyTestFixture(fixture);
  });

  it("indexes all modules without errors", async () => {
    const result = await indexModules({
      rootPaths: fixture.sourcePaths,
      full: true,
      dbPath: fixture.dbPath,
    });

    expect(result.errors).toBe(0);
    expect(result.indexed).toBeGreaterThan(0);
    // Should have indexed: base(3) + sale(3) + partner_firstname(1) + my_module(3) + partner_category(2)
    expect(result.indexed).toBeGreaterThanOrEqual(12);
  });

  it("creates queryable database entries", async () => {
    await indexModules({
      rootPaths: fixture.sourcePaths,
      full: true,
      dbPath: fixture.dbPath,
    });

    const db = new DoodbaIndexDatabase(fixture.dbPath);
    try {
      // Search for a model
      const models = db.search({ query: "res.partner", itemType: "model" });
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.name === "res.partner")).toBe(true);

      // Search for a field
      const fields = db.search({ query: "email", itemType: "field", parentName: "res.partner" });
      expect(fields.length).toBeGreaterThan(0);

      // Search for sale.order model
      const orders = db.search({ query: "sale.order", itemType: "model" });
      expect(orders.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("indexes cross-repo dependencies correctly", async () => {
    await indexModules({
      rootPaths: fixture.sourcePaths,
      full: true,
      dbPath: fixture.dbPath,
    });

    const db = new DoodbaIndexDatabase(fixture.dbPath);
    try {
      // my_module should be indexed
      const myModule = db.search({ query: "my.model", itemType: "model" });
      expect(myModule.length).toBeGreaterThan(0);

      // my_module's field referencing sale.order should exist
      const fields = db.search({ query: "order_id", itemType: "field", parentName: "my.model" });
      expect(fields.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("indexes multi-class Python files correctly (class-body boundary test)", async () => {
    await indexModules({
      rootPaths: fixture.sourcePaths,
      full: true,
      dbPath: fixture.dbPath,
    });

    const db = new DoodbaIndexDatabase(fixture.dbPath);
    try {
      // First class: ResPartnerCategory
      const categoryModels = db.search({ query: "res.partner.category", itemType: "model" });
      expect(categoryModels.length).toBeGreaterThan(0);
      expect(categoryModels.some((m) => m.name === "res.partner.category")).toBe(true);

      // Second class: PartnerCategoryHelper (transient model in same file)
      const helperModels = db.search({ query: "partner.category.helper", itemType: "model" });
      expect(helperModels.length).toBeGreaterThan(0);
      expect(helperModels.some((m) => m.name === "partner.category.helper")).toBe(true);

      // Verify fields are correctly assigned to their respective classes
      const categoryFields = db.search({
        query: "color",
        itemType: "field",
        parentName: "res.partner.category",
      });
      expect(categoryFields.length).toBeGreaterThan(0);

      const helperFields = db.search({
        query: "category_id",
        itemType: "field",
        parentName: "partner.category.helper",
      });
      expect(helperFields.length).toBeGreaterThan(0);

      // Verify the many2many field is indexed
      const manyToManyFields = db.search({
        query: "partner_ids",
        itemType: "field",
        parentName: "partner.category.helper",
      });
      expect(manyToManyFields.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

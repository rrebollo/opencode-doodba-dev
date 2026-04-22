import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { DoodbaIndexDatabase } from "../../src/database";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TMP_DB: string;
let db: DoodbaIndexDatabase;

beforeEach(() => {
  TMP_DB = join(tmpdir(), `test-database-${crypto.randomUUID()}.db`);
  db = new DoodbaIndexDatabase(TMP_DB);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TMP_DB);
  } catch {
    /* ignore */
  }
});

describe("transactions", () => {
  test("commitTransaction persists data", () => {
    db.beginTransaction();
    db.upsertItem("model", "sale.order", null, "sale", {}, 0);
    db.commitTransaction();
    const results = db.search({ query: "sale.order" });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("sale.order");
  });

  test("rollbackTransaction reverts data", () => {
    db.beginTransaction();
    db.upsertItem("model", "will.rollback", null, "test", {}, 0);
    db.rollbackTransaction();
    const results = db.search({ query: "will.rollback" });
    expect(results).toHaveLength(0);
  });
});

describe("findRefs", () => {
  test("returns typed ItemReference objects", () => {
    const id = db.upsertItem("model", "sale.order", null, "sale", {}, 0);
    db.upsertReference(id, "/path/to/file.py", 42, "definition", "SaleOrder");
    const refs = db.findRefs("sale.order", "model");
    expect(refs).toHaveLength(1);
    expect(refs[0].filePath).toBe("/path/to/file.py");
    expect(refs[0].lineNumber).toBe(42);
    expect(refs[0].referenceType).toBe("definition");
  });
});

describe("search default limit", () => {
  test("returns at most DEFAULT_SEARCH_LIMIT results by default", () => {
    for (let i = 0; i < 60; i++) {
      db.upsertItem("model", `model.${i}`, null, "test", {}, 0);
    }
    const results = db.search({});
    expect(results.length).toBe(50); // DEFAULT_SEARCH_LIMIT
  });
});

describe("null parent_name uniqueness", () => {
  test("duplicate items with null parent_name should not be stored", () => {
    // Insert first item with null parent_name
    db.upsertItem("model", "res.users", null, "base", { foo: "bar" }, 0);
    // Insert identical item except with different attributes (simulating second upsert)
    db.upsertItem("model", "res.users", null, "base", { baz: "qux" }, 0);

    // Search for the item by type, name, and module
    const results = db.search({
      itemType: "model",
      query: "res.users",
      module: "base",
    });

    // Should have only 1 row (deduped)
    expect(results).toHaveLength(1);
    // Should reflect the second (last) upsert
    expect(results[0].attributes).toEqual({ baz: "qux" });
  });
});

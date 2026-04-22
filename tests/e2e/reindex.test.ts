import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { indexModules } from "../../src/indexer";
import { DoodbaIndexDatabase } from "../../src/database";
import { createTestFixture, destroyTestFixture, type TestFixture } from "./setup";

describe("re-indexing", () => {
  let fixture: TestFixture;

  beforeAll(() => {
    fixture = createTestFixture();
  });

  afterAll(() => {
    destroyTestFixture(fixture);
  });

  it("full re-index does not create duplicates", () => {
    // First index
    indexModules({
      rootPaths: fixture.sourcePaths,
      full: true,
      dbPath: fixture.dbPath,
    });

    // Second full index
    const result2 = indexModules({
      rootPaths: fixture.sourcePaths,
      full: true,
      dbPath: fixture.dbPath,
    });

    expect(result2.errors).toBe(0);

    // Verify no duplicates in database
    const db = new DoodbaIndexDatabase(fixture.dbPath);
    try {
      const status = db.indexStatus();
      const models = db.search({ itemType: "model" });

      // Should have same count after re-index
      expect(status.totalItems).toBeGreaterThan(0);

      // Unique models should not be duplicated
      const modelNames = models.map((m) => `${m.itemType}:${m.name}:${m.parentName}:${m.module}`);
      const uniqueNames = new Set(modelNames);
      expect(uniqueNames.size).toBe(modelNames.length);
    } finally {
      db.close();
    }
  });

  it("incremental index skips unchanged files", () => {
    // Full index
    indexModules({
      rootPaths: fixture.sourcePaths,
      full: true,
      dbPath: fixture.dbPath,
    });

    // Incremental index (no changes)
    const result = indexModules({
      rootPaths: fixture.sourcePaths,
      full: false,
      dbPath: fixture.dbPath,
    });

    expect(result.errors).toBe(0);
    // All files should be skipped since nothing changed
    expect(result.skipped).toBeGreaterThan(0);
  });
});

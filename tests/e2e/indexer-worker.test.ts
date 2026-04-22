import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSourcePaths } from "../../src/doodba-detector";
import { discoverModules } from "../../src/dependency-tree";
import { indexModules } from "../../src/indexer";
import { createTestFixture, destroyTestFixture, type TestFixture } from "./setup";

describe("indexer-worker guard-check logic", () => {
  describe("READY path — valid Doodba layout produces non-empty sourcePaths", () => {
    let fixture: TestFixture;

    beforeAll(() => {
      fixture = createTestFixture();
    });

    afterAll(() => {
      destroyTestFixture(fixture);
    });

    it("getSourcePaths on repo-group layout returns indexable paths", () => {
      // This tests the exact scenario that getSourcePaths receives:
      // a doodbaRoot with odoo/custom/src containing repo groups (not modules directly)
      const sourcePaths = getSourcePaths(fixture.doodbaRoot);

      // Should find the repo groups created by the fixture
      expect(sourcePaths.length).toBeGreaterThan(0);
      expect(sourcePaths.some((p) => p.includes("odoo"))).toBe(true);
      expect(sourcePaths.some((p) => p.includes("custom-repo"))).toBe(true);
    });

    it("getSourcePaths result is indexable by indexModules", async () => {
      // Verify the complete pipeline: getSourcePaths → indexModules
      const sourcePaths = getSourcePaths(fixture.doodbaRoot);
      expect(sourcePaths.length).toBeGreaterThan(0);

      const result = await indexModules({
        rootPaths: sourcePaths,
        full: true,
        dbPath: fixture.dbPath,
      });

      // Should successfully index modules (not fail with "No source paths" error)
      expect(result.indexed).toBeGreaterThan(0);
      expect(result.errors).toBe(0);
    });
  });

  describe("FAILED path — empty odoo/custom/src (original bug)", () => {
    it("getSourcePaths returns empty array when src dir is empty", () => {
      // Reproduces the original bug scenario:
      // Doodba marker exists, src/ exists, but contains no repo groups
      const fixture = mkdtempSync(join(tmpdir(), "worker-empty-src-"));
      const srcDir = join(fixture, "odoo", "custom", "src");

      // Create marker and empty src
      writeFileSync(join(fixture, ".copier-answers.yml"), "");
      mkdirSync(srcDir, { recursive: true });

      try {
        const sourcePaths = getSourcePaths(fixture);

        // CRITICAL: This is where the guard-check in indexer-worker.ts would fail
        // If sourcePaths is empty, the worker writes FAILED state
        expect(sourcePaths).toEqual([]);
      } finally {
        rmSync(fixture, { recursive: true });
      }
    });

    it("getSourcePaths skips directories without Odoo content", () => {
      // A repo group with no modules should be returned (as it's a valid repo group path),
      // but the dependency tree discovery will find no modules in it
      const fixture = mkdtempSync(join(tmpdir(), "worker-empty-repo-"));
      const srcDir = join(fixture, "odoo", "custom", "src");

      // Create marker and a repo group with NO modules
      writeFileSync(join(fixture, ".copier-answers.yml"), "");
      mkdirSync(join(srcDir, "empty_repo"), { recursive: true });

      try {
        const sourcePaths = getSourcePaths(fixture);

        // getSourcePaths should return the empty_repo dir (it's a non-hidden dir)
        expect(sourcePaths.length).toBe(1);
        expect(sourcePaths[0]).toContain("empty_repo");

        // But when passed to discoverModules, no actual modules will be found
        const modules = discoverModules(sourcePaths);
        expect(modules.size).toBe(0);
      } finally {
        rmSync(fixture, { recursive: true });
      }
    });
  });
});

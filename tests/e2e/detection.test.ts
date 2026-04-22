import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDoodbaRoot } from "../../src/doodba-detector";

describe("findDoodbaRoot", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "doodba-detect-"));
    // Create nested structure
    mkdirSync(join(tmpDir, "project", "odoo", "custom", "src"), { recursive: true });
    writeFileSync(join(tmpDir, "project", ".copier-answers.yml"), "");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("finds .copier-answers.yml in parent directory", () => {
    const startDir = join(tmpDir, "project", "odoo", "custom", "src");
    const result = findDoodbaRoot(startDir);
    expect(result).toBe(join(tmpDir, "project"));
  });

  it("returns null when marker is missing", () => {
    const orphanDir = mkdtempSync(join(tmpdir(), "doodba-orphan-"));
    const result = findDoodbaRoot(orphanDir);
    expect(result).toBeNull();
    rmSync(orphanDir, { recursive: true });
  });
});

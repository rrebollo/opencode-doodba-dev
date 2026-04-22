import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexModules } from "../../src/indexer";

describe("missing dependency reporting", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "doodba-missing-deps-"));
    // Create a module that depends on a non-existent module
    const modDir = join(tmpDir, "my_module");
    mkdirSync(modDir, { recursive: true });
    writeFileSync(
      join(modDir, "__manifest__.py"),
      '{"name": "my_module", "depends": ["nonexistent_module"]}'
    );
    mkdirSync(join(modDir, "models"), { recursive: true });
    writeFileSync(
      join(modDir, "models", "my_model.py"),
      `from odoo import models, fields

class MyModel(models.Model):
    _name = "my.model"
    name = fields.Char()
`
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("reports missing dependencies after indexing", async () => {
    const dbDir = join(tmpDir, ".opencode", "doodba-dev");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "index.db");

    const result = await indexModules({
      rootPaths: [tmpDir],
      full: true,
      dbPath,
    });

    expect(result.missingDeps).toContain("nonexistent_module");
    expect(result.missingDeps.length).toBe(1);
  });
});

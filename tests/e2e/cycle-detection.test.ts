import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexModules } from "../../src/indexer";
import { DoodbaIndexDatabase } from "../../src/database";

describe("cycle detection during indexing", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "doodba-cycles-"));

    // Create two modules that depend on each other (A -> B -> A)
    for (const [name, deps] of [
      ["mod_a", ["mod_b"]],
      ["mod_b", ["mod_a"]],
    ] as const) {
      const modDir = join(tmpDir, name);
      mkdirSync(join(modDir, "models"), { recursive: true });
      writeFileSync(
        join(modDir, "__manifest__.py"),
        `{"name": "${name}", "depends": ${JSON.stringify(deps)}}`
      );
      writeFileSync(
        join(modDir, "models", "model.py"),
        `from odoo import models, fields\nclass M(models.Model):\n    _name = "${name}.model"\n    x = fields.Char()\n`
      );
    }
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("emits a warning when cyclic dependencies are detected", async () => {
    const warns: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args) => {
      warns.push(args.join(" "));
    });

    const dbDir = join(tmpDir, ".opencode", "doodba-dev");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "index.db");

    await indexModules({ rootPaths: [tmpDir], full: true, dbPath });

    spy.mockRestore();

    const cycleWarn = warns.find((w) => w.toLowerCase().includes("cycl"));
    expect(cycleWarn).toBeDefined();
  });

  it("does not crash when cyclic dependencies exist", async () => {
    const dbDir = join(tmpDir, ".opencode", "doodba-dev2");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "index.db");

    // Should not throw
    await expect(async () => {
      await indexModules({ rootPaths: [tmpDir], full: true, dbPath });
    }).not.toThrow();
  });
});

describe("symlink cycle detection in walkDir", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "doodba-walkdir-cycles-"));

    const modDir = join(tmpDir, "mod_c");
    mkdirSync(join(modDir, "models"), { recursive: true });
    writeFileSync(join(modDir, "__manifest__.py"), `{ "name": "mod_c", "depends": [] }`);
    writeFileSync(
      join(modDir, "models", "model.py"),
      `from odoo import models, fields\nclass M(models.Model):\n    _name = "mod_c.model"\n    x = fields.Char()\n`
    );

    // Create a symlink cycle inside the module tree
    const target = join(modDir, "models");
    const link = join(target, "loop");
    symlinkSync(target, link, "dir");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("does not crash when a symlink cycle exists in module directory", async () => {
    const dbDir = join(tmpDir, ".opencode", "doodba-dev");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "index.db");

    await expect(async () => {
      await indexModules({ rootPaths: [tmpDir], full: true, dbPath });
    }).not.toThrow();
  });

  it("skips symlinks without crashing", async () => {
    const dbDir = join(tmpDir, ".opencode", "doodba-dev2");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "index.db");

    // Should complete without crashing even with symlinks
    await expect(async () => {
      await indexModules({ rootPaths: [tmpDir], full: true, dbPath });
    }).not.toThrow();

    // Verify database was created successfully
    const db = new DoodbaIndexDatabase(dbPath);
    const items = db.search({ query: "mod_c" });
    db.close();
    expect(items.length).toBeGreaterThan(0);
  });
});

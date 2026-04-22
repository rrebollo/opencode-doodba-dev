import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { findDoodbaRoot, getSourcePaths } from "../../src/doodba-detector";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TMP: string;

beforeEach(() => {
  TMP = join(tmpdir(), `doodba-detector-test-${crypto.randomUUID()}`);
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("findDoodbaRoot", () => {
  test("returns null when marker is not found within MAX_WALK_DEPTH", () => {
    const deep = join(TMP, "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u");
    mkdirSync(deep, { recursive: true });
    const result = findDoodbaRoot(deep);
    expect(result).toBeNull();
  });

  test("finds root at ancestor directory", () => {
    const root = join(TMP, "project");
    const subDir = join(root, "src", "modules");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(root, ".copier-answers.yml"), "");
    const result = findDoodbaRoot(subDir);
    expect(result).toBe(root);
  });
});

describe("getSourcePaths", () => {
  test("excludes hidden directories", () => {
    const root = join(TMP, "doodba");
    const srcDir = join(root, "odoo", "custom", "src");
    mkdirSync(join(srcDir, ".git"), { recursive: true });
    mkdirSync(join(srcDir, "my_module"), { recursive: true });
    writeFileSync(join(srcDir, "my_module", "__manifest__.py"), "");
    const paths = getSourcePaths(root);
    expect(paths.every((p) => !p.includes("/.git"))).toBe(true);
  });

  test("returns all non-hidden directories (regardless of __manifest__.py)", () => {
    const root = join(TMP, "doodba2");
    const srcDir = join(root, "odoo", "custom", "src");
    mkdirSync(join(srcDir, "with_manifest"), { recursive: true });
    writeFileSync(join(srcDir, "with_manifest", "__manifest__.py"), "");
    mkdirSync(join(srcDir, "without_manifest"), { recursive: true }); // repo group dir
    const paths = getSourcePaths(root);
    expect(paths).toHaveLength(2);
    expect(paths.some((p) => p.endsWith("with_manifest"))).toBe(true);
    expect(paths.some((p) => p.endsWith("without_manifest"))).toBe(true);
  });

  test("returns empty array when odoo/custom/src does not exist", () => {
    const root = join(TMP, "doodba3"); // no src dir
    mkdirSync(root, { recursive: true });
    expect(getSourcePaths(root)).toEqual([]);
  });
});

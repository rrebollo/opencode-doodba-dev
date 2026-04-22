import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { discoverModules } from "../../src/dependency-tree";
import { createTestFixture, destroyTestFixture, type TestFixture } from "./setup";

describe("indexing - custom addons", () => {
  let fixture: TestFixture;

  beforeAll(() => {
    fixture = createTestFixture();
  });

  afterAll(() => {
    destroyTestFixture(fixture);
  });

  it("discovers partner_firstname in custom repo", () => {
    const modules = discoverModules(fixture.sourcePaths);
    expect(modules.has("partner_firstname")).toBe(true);
    expect(modules.get("partner_firstname")?.depends).toEqual(["base"]);
  });

  it("discovers my_module in custom repo", () => {
    const modules = discoverModules(fixture.sourcePaths);
    expect(modules.has("my_module")).toBe(true);
    expect(modules.get("my_module")?.depends).toEqual(["sale", "partner_firstname"]);
  });

  it("includes all 5 modules from both repos", () => {
    const modules = discoverModules(fixture.sourcePaths);
    expect(modules.size).toBe(5);
    expect(Array.from(modules.keys()).sort()).toEqual([
      "base",
      "my_module",
      "partner_category",
      "partner_firstname",
      "sale",
    ]);
  });
});

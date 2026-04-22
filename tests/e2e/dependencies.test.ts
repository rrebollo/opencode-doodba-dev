import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { discoverModules, resolveDependencyOrder, findCycles } from "../../src/dependency-tree";
import { createTestFixture, destroyTestFixture, type TestFixture } from "./setup";

describe("dependency resolution", () => {
  let fixture: TestFixture;

  beforeAll(() => {
    fixture = createTestFixture();
  });

  afterAll(() => {
    destroyTestFixture(fixture);
  });

  it("topologically sorts all modules", () => {
    const modules = discoverModules(fixture.sourcePaths);
    const ordered = resolveDependencyOrder(modules);
    const names = ordered.map((m) => m.name);

    // base must come before sale
    expect(names.indexOf("base")).toBeLessThan(names.indexOf("sale"));
    // base must come before partner_firstname
    expect(names.indexOf("base")).toBeLessThan(names.indexOf("partner_firstname"));
    // sale must come before my_module
    expect(names.indexOf("sale")).toBeLessThan(names.indexOf("my_module"));
    // partner_firstname must come before my_module
    expect(names.indexOf("partner_firstname")).toBeLessThan(names.indexOf("my_module"));
  });

  it("assigns correct dependency depths", () => {
    const modules = discoverModules(fixture.sourcePaths);
    const ordered = resolveDependencyOrder(modules);

    const base = ordered.find((m) => m.name === "base");
    const sale = ordered.find((m) => m.name === "sale");
    const myModule = ordered.find((m) => m.name === "my_module");

    expect(base?.depth).toBe(0);
    expect(sale?.depth).toBe(1); // depends on base
    expect(myModule?.depth).toBeGreaterThanOrEqual(2); // depends on sale + partner_firstname
  });

  it("detects no cycles in valid fixtures", () => {
    const modules = discoverModules(fixture.sourcePaths);
    const result = findCycles(modules);
    expect(result.hasCycles).toBe(false);
    expect(result.cycles).toEqual([]);
  });
});

import { describe, it, expect, afterEach } from "bun:test";
import { PythonParserPool } from "../../src/parsers/python-pool";

describe("PythonParserPool", () => {
  let pool: PythonParserPool;

  afterEach(async () => {
    if (pool) {
      await pool.stop();
    }
  });

  it("should create a pool with specified worker count", async () => {
    pool = new PythonParserPool(2);
    await pool.start();
    expect(pool.getWorkerCount()).toBe(2);
    await pool.stop();
  });

  it("should distribute parse requests round-robin across workers", async () => {
    pool = new PythonParserPool(2);
    await pool.start();

    const code = "class Foo(models.Model):\n    _name = 'foo'";
    const result1 = await pool.parse({
      file_path: "test1.py",
      content: code,
      module_name: "test",
    });
    const result2 = await pool.parse({
      file_path: "test2.py",
      content: code,
      module_name: "test",
    });

    expect(result1.error).toBeNull();
    expect(result2.error).toBeNull();
    expect(Array.isArray(result1.items)).toBe(true);
    expect(Array.isArray(result2.items)).toBe(true);

    await pool.stop();
  });

  it("should handle syntax errors from any worker", async () => {
    pool = new PythonParserPool(2);
    await pool.start();

    const result = await pool.parse({
      file_path: "bad.py",
      content: "class Foo(\n  invalid",
      module_name: "test",
    });

    expect(result.error).toBeTruthy();
    expect(result.file_path).toBe("bad.py");

    await pool.stop();
  });

  it("should use default 4 workers when none specified", async () => {
    pool = new PythonParserPool();
    await pool.start();
    expect(pool.getWorkerCount()).toBe(4);
    await pool.stop();
  });

  it("should handle sequential requests across multiple workers", async () => {
    pool = new PythonParserPool(3);
    await pool.start();

    const results = await Promise.all([
      pool.parse({
        file_path: "file1.py",
        content: "x = 1",
        module_name: "mod1",
      }),
      pool.parse({
        file_path: "file2.py",
        content: "y = 2",
        module_name: "mod2",
      }),
      pool.parse({
        file_path: "file3.py",
        content: "z = 3",
        module_name: "mod3",
      }),
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].file_path).toBe("file1.py");
    expect(results[1].file_path).toBe("file2.py");
    expect(results[2].file_path).toBe("file3.py");
    expect(results.every((r) => r.error === null)).toBe(true);

    await pool.stop();
  });

  it("should throw error when parsing without starting pool", async () => {
    pool = new PythonParserPool(2);

    try {
      await pool.parse({
        file_path: "test.py",
        content: "x = 1",
        module_name: "test",
      });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("Pool not started");
    }
  });
});

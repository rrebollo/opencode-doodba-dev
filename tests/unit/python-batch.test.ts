import { describe, it, expect, afterEach } from "bun:test";
import { PythonBatchParser } from "../../src/parsers/python-batch";

describe("PythonBatchParser", () => {
  let parser: PythonBatchParser;

  afterEach(async () => {
    if (parser) {
      await parser.stop();
    }
  });

  it("should parse a simple Python class", async () => {
    parser = new PythonBatchParser();
    await parser.start();

    const result = await parser.parse({
      file_path: "test.py",
      content: "class Foo(models.Model):\n    _name = 'foo'",
      module_name: "test",
    });

    expect(result.error).toBeNull();
    expect(result.items).toBeDefined();
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.file_path).toBe("test.py");
  });

  it("should handle syntax errors", async () => {
    parser = new PythonBatchParser();
    await parser.start();

    const result = await parser.parse({
      file_path: "bad.py",
      content: "class Foo(\n  invalid",
      module_name: "test",
    });

    expect(result.error).toBeTruthy();
    expect(result.file_path).toBe("bad.py");
    expect(Array.isArray(result.items)).toBe(true);
  });

  it("should handle multiple sequential parse requests", async () => {
    parser = new PythonBatchParser();
    await parser.start();

    const result1 = await parser.parse({
      file_path: "file1.py",
      content: "x = 1",
      module_name: "mod1",
    });

    const result2 = await parser.parse({
      file_path: "file2.py",
      content: "y = 2",
      module_name: "mod2",
    });

    expect(result1.file_path).toBe("file1.py");
    expect(result2.file_path).toBe("file2.py");
    expect(result1.error).toBeNull();
    expect(result2.error).toBeNull();
  });

  it("should auto-start process on first parse if not started", async () => {
    parser = new PythonBatchParser();

    const result = await parser.parse({
      file_path: "test.py",
      content: "x = 1",
      module_name: "test",
    });

    expect(result.error).toBeNull();
    expect(result.file_path).toBe("test.py");
  });
});

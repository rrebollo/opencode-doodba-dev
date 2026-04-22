// tests/unit/parsers.test.ts
import { describe, expect, test } from "bun:test"
import { qualifyXmlId, lineNumberAt, toArray } from "../../src/parsers/utils"

describe("qualifyXmlId", () => {
  test("returns id unchanged when already qualified", () => {
    expect(qualifyXmlId("sale.order_form", "sale")).toBe("sale.order_form")
  })
  test("prefixes module when id has no dot", () => {
    expect(qualifyXmlId("order_form", "sale")).toBe("sale.order_form")
  })
  test("empty id returns module prefix", () => {
    expect(qualifyXmlId("", "sale")).toBe("sale.")
  })
})

describe("lineNumberAt", () => {
  test("line 1 for index 0", () => {
    expect(lineNumberAt("hello\nworld", 0)).toBe(1)
  })
  test("line 2 after first newline", () => {
    expect(lineNumberAt("hello\nworld", 6)).toBe(2)
  })
  test("line 1 when no newlines", () => {
    expect(lineNumberAt("hello", 4)).toBe(1)
  })
})

describe("toArray", () => {
  test("wraps a non-array value in an array", () => {
    expect(toArray("x")).toEqual(["x"])
  })
  test("returns array as-is", () => {
    expect(toArray(["x", "y"])).toEqual(["x", "y"])
  })
  test("returns empty array for undefined", () => {
    expect(toArray(undefined)).toEqual([])
  })
  test("returns empty array for null", () => {
    expect(toArray(null)).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import { toErrorMessage, formatResponse } from "../../src/tools/helpers"

describe("toErrorMessage", () => {
  test("returns message from Error", () => {
    expect(toErrorMessage(new Error("oops"))).toBe("oops")
  })
  test("stringifies non-Error values", () => {
    expect(toErrorMessage(42)).toBe("42")
    expect(toErrorMessage("raw string")).toBe("raw string")
  })
  test("handles null", () => {
    expect(toErrorMessage(null)).toBe("null")
  })
})

describe("formatResponse", () => {
  test("includes status and results", () => {
    const out = formatResponse("READY", [{ name: "sale.order" }])
    expect(out._doodba_status).toBe("READY")
    expect(out.results).toHaveLength(1)
  })
  test("includes message when provided", () => {
    const out = formatResponse("FAILED", [], "something broke")
    expect(out._message).toBe("something broke")
  })
  test("omits message when undefined", () => {
    const out = formatResponse("READY", [])
    expect(out._message).toBeUndefined()
  })
})

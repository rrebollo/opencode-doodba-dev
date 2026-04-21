import { describe, it, expect } from "bun:test"
import { globToRegex } from "../../src/glob"

describe("globToRegex", () => {
  it("matches * as any sequence of characters", () => {
    const re = globToRegex("sale*")
    expect(re.test("sale")).toBe(true)
    expect(re.test("sale_order")).toBe(true)
    expect(re.test("sale_management")).toBe(true)
    expect(re.test("base")).toBe(false)
  })

  it("matches ? as exactly one character", () => {
    const re = globToRegex("sal?")
    expect(re.test("sale")).toBe(true)
    expect(re.test("salx")).toBe(true)
    expect(re.test("sal")).toBe(false)
    expect(re.test("sales")).toBe(false)
  })

  it("does not treat regex special chars as regex", () => {
    // A literal dot should match only a dot, not any character
    const re = globToRegex("my.module")
    expect(re.test("my.module")).toBe(true)
    expect(re.test("myXmodule")).toBe(false)
  })

  it("anchors pattern to full string", () => {
    const re = globToRegex("sale")
    expect(re.test("sale")).toBe(true)
    expect(re.test("sale_order")).toBe(false)
    expect(re.test("my_sale")).toBe(false)
  })

  it("handles * in the middle", () => {
    const re = globToRegex("sale*order")
    expect(re.test("sale_order")).toBe(true)
    expect(re.test("saleorder")).toBe(true)
    expect(re.test("sale_x_order")).toBe(true)
    expect(re.test("sale_orders")).toBe(false)
  })
})

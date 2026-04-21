import { describe, it, expect } from "bun:test"
import { existsSync } from "node:fs"
import { createTestFixture, destroyTestFixture } from "./setup"

describe("cleanup", () => {
  it("removes temporary directory after destroy", () => {
    const fixture = createTestFixture()
    expect(existsSync(fixture.rootDir)).toBe(true)

    destroyTestFixture(fixture)
    expect(existsSync(fixture.rootDir)).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import { readState, updateState } from "../../src/project-state"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("updateState", () => {
  test("handles concurrent state updates atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "state-concurrent-"))
    try {
      updateState(root, { status: "INDEXING" })
      updateState(root, { error: "test-error" })

      const state = readState(root)
      expect(state.status).toBe("INDEXING")
      expect(state.error).toBe("test-error")
    } finally {
      rmSync(root, { recursive: true })
    }
  })
})

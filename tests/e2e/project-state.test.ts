import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readState, updateState, DEFAULT_STATE } from "../../src/project-state"

describe("project-state", () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "doodba-project-state-"))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true })
  })

  it("returns DEFAULT_STATE when no state file exists", () => {
    const state = readState(tmpDir)
    expect(state.status).toBe("NO_PROJECT")
    expect(state.missingDeps).toEqual([])
  })

  it("stores and retrieves missingDeps", () => {
    updateState(tmpDir, {
      status: "READY",
      missingDeps: ["nonexistent_module", "another_missing"],
    })
    const state = readState(tmpDir)
    expect(state.status).toBe("READY")
    expect(state.missingDeps).toEqual(["nonexistent_module", "another_missing"])
  })

  it("defaults missingDeps to [] when not present in stored JSON", () => {
    // Write a state.json without missingDeps (simulating old format)
    const stateDir = join(tmpDir, ".opencode", "doodba-dev")
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      join(stateDir, "state.json"),
      JSON.stringify({ status: "READY", indexedFiles: 5 }),
    )
    const state = readState(tmpDir)
    expect(state.missingDeps).toEqual([])
  })
})

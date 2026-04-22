# Testing Guide

## Overview

This guide documents design patterns and anti-patterns we've discovered in our e2e test suite. We perform root-cause analysis on bugs that shipped undetected. This guide captures the three structural gaps we identified.

## Anti-Pattern 1: Fixture Too Narrow

### Description

Fixtures that only test the "happy path" edge case, missing bugs at boundaries. Tests pass on simplified data that doesn't represent real-world complexity.

### Example

All Python test files had exactly one class. The class-body boundary bug only manifested with two or more classes. Tests with single-class fixtures never caught this.

### How to Catch It

Before merging, ask:

- Does my fixture test realistic edge cases?
- What if there are multiple items (files, classes, records)?
- Have I tested both empty and non-empty collections?
- Does my test cover the boundary conditions where the bug would appear?

### Fix in This Codebase

`tests/e2e/fixtures/res_partner_category.py` now contains two model classes, testing the multi-class scenario.

---

## Anti-Pattern 2: Vacuous Assertion

### Description

Assertions that pass even when the feature returns empty/zero/null, only failing on undefined. The test checks that something exists as a type, not that it contains meaningful data.

### Examples

```javascript
// BAD: Passes when refs = []
expect(Array.isArray(refs)).toBe(true);

// BAD: Passes when stats.view = 0
expect(stats.view >= 0).toBe(true);

// BAD: Passes when x = 0
expect(typeof x === "number").toBe(true);
```

### Correct Pattern

```javascript
// GOOD: Checks actual content
expect(refs.length).toBeGreaterThan(0);

// GOOD: Checks meaningful value
expect(stats.view).toBeGreaterThan(0);

// GOOD: Checks shape and content
expect(refs).toEqual(expect.arrayContaining([expected_item]));
```

### How to Catch It

Before merging, ask:

- Does my assertion verify the feature actually returned meaningful data?
- Or is it just checking that the code didn't crash?
- Would this test fail if I returned an empty result?
- Would this test fail if I returned null/undefined?

---

## Anti-Pattern 3: Layer Bypass

### Description

Tests that call internal functions directly, skipping the public API layer. This misses bugs in the API contract, such as path resolution, async handling, or initialization logic that only happens in the public API.

### Example

Tests call `indexModules()` directly with hardcoded paths. They never call the **plugin factory** (`DoodbaDevPlugin`), which is responsible for:

- Resolving `doodbaRoot` from the project configuration
- Spawning worker processes
- Managing initialization

Bugs in the plugin factory's path resolution never surface because tests bypass it.

### How to Catch It

Before merging, ask:

- Am I testing internal functions or the public API?
- Would a user encounter this code path in production?
- Am I passing hardcoded values where the real API would resolve them?
- Would this test catch a bug in initialization or setup?

### Fix in This Codebase

`tests/e2e/plugin-integration.test.ts` now tests the plugin factory directly, validating the full integration path.

---

## Pre-Merge Checklist

Use this checklist before submitting a pull request:

- [ ] **Fixture Complexity:** Fixtures test realistic complexity, not just happy path (Anti-Pattern 1)
  - Multiple items (files, classes, records) are tested
  - Edge cases and boundaries are covered
  - Empty and non-empty collections are tested

- [ ] **Assertion Quality:** Assertions verify actual data presence/shape, not just type (Anti-Pattern 2)
  - Tests check for meaningful data, not just that code didn't crash
  - Empty/zero/null results would cause the test to fail
  - Assertions use `.toBeGreaterThan(0)`, `.toEqual(expect.arrayContaining(...))`, etc.

- [ ] **API Layer Coverage:** Tests call public APIs, not just internal functions (Anti-Pattern 3)
  - Integration points (factories, public methods) are tested
  - Tests use the same code paths as production users
  - Initialization and setup logic is validated

- [ ] **Tests Pass:** `bun test` runs successfully with all tests passing

---

## References

- Root cause analysis: `docs/superpowers/plans/2026-04-21-test-quality.md`
- Bug tracking: `docs/superpowers/plans/2026-04-21-architectural-backlog.md`

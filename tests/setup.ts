// Global test setup for opencode-doodba-dev
// This file is loaded before all tests via bunfig.toml

const PROJECT_ROOT = process.cwd()

// Validate that tests don't leak process.cwd() changes
process.on('exit', () => {
  if (process.cwd() !== PROJECT_ROOT) {
    console.error(`CRITICAL: Test suite left process in ${process.cwd()}, expected ${PROJECT_ROOT}`)
    process.chdir(PROJECT_ROOT)
  }
})

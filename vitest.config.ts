import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Every test gets a scratch PORCH_HOME and HOME from tests/setup.ts, so no
    // test can write to the real ~/.porch or ~/.claude.
    setupFiles: ["tests/setup.ts"],
    testTimeout: 20000,
  },
});

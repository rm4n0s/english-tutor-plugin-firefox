import { defineConfig } from "vitest/config";

// Node by default. A test file that needs the DOM starts with
// `// @vitest-environment happy-dom`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    setupFiles: ["src/core/testing/idb-globals.ts"],
  },
});

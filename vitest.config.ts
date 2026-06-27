import { defineConfig } from "vitest/config";

// The *.test.mts files under src/__tests__ are standalone tsx smoke scripts
// (they call process.exit), run via `npm run test:smoke`. Keep vitest to the
// proper *.test.ts unit suites.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});

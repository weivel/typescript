import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["model/**", "conformance/**", "java/**", "dist/**", "node_modules/**"],
  },
});

import { defineConfig } from "vitest/config";

// Backend tests: each one starts the real Rust binaries with fake engines and checks their API.
// They run one file at a time, since each starts its own server.
export default defineConfig({
  test: {
    include: ["tests/server/**/*.test.mjs"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});

// Builds the first-run screen of the Mac app into desktop/setup-dist: one classic
// script (setup.js, a plain IIFE, so it runs from a file:// page) and its index.html.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  publicDir: here("./public"),
  build: {
    outDir: here("../setup-dist"),
    emptyOutDir: true,
    lib: {
      entry: here("./setup.ts"),
      name: "LiquidSetup",
      formats: ["iife"],
      fileName: () => "setup.js",
    },
  },
});

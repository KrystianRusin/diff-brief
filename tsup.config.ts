import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  // Splitting keeps the hook's dynamic import in its own small chunk, so
  // `diffbrief hook` never loads commander or the rest of the CLI.
  splitting: true,
  clean: true,
  sourcemap: true,
});

import { solidPlugin } from "esbuild-plugin-solid";
import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      tui: "./tui.tsx",
    },
    format: ["esm"],
    target: "node22",
    bundle: true,
    splitting: false,
    clean: true,
    outDir: "dist",
    external: [
      "@opencode-ai/plugin",
      "@opencode-ai/plugin/tui",
      "@opentui/core",
      "@opentui/solid",
      "solid-js",
    ],
    esbuildPlugins: [
      solidPlugin({ solid: { generate: "universal", moduleName: "@opentui/solid" } }),
    ],
  },
]);

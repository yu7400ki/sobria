import { pandacss } from "@pandacss/vite";
import { rinka } from "rinka/vite";
import { defineConfig } from "vite";

import { mdx } from "./plugins/mdx.ts";

export default defineConfig({
  plugins: [
    pandacss({ cwd: import.meta.dirname, configPath: "theme/panda.config.ts" }),
    mdx({ codeBlock: "/src/routes/[...slug]/code-block.tsx" }),
    rinka({ extensions: [".mdx"], output: "static" }),
  ],
  resolve: { tsconfigPaths: true },
});

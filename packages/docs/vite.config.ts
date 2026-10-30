import { pandacss } from "@pandacss/vite";
import { sobria } from "sobria/vite";
import { defineConfig } from "vite";

import { mdx } from "./plugins/mdx.ts";

export default defineConfig({
  // GitHub Pages のプロジェクトのサイトの URL のパスである
  base: "/sobria/",
  plugins: [
    pandacss({ cwd: import.meta.dirname, configPath: "theme/panda.config.ts" }),
    mdx({ codeBlock: "/src/routes/[...slug]/code-block.tsx" }),
    sobria({ extensions: [".mdx"], output: "static" }),
  ],
  resolve: { tsconfigPaths: true },
  // 色のトークンの light-dark() を、変換せずに出力する
  build: { cssTarget: ["chrome123", "edge123", "firefox120", "safari17.5"] },
});

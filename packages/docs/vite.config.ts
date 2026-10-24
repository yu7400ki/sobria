import { rinka } from "rinka/vite";
import { defineConfig } from "vite";

import { mdx } from "./plugins/mdx.ts";

export default defineConfig({
  plugins: [mdx(), rinka({ extensions: [".mdx"], output: "static" })],
});

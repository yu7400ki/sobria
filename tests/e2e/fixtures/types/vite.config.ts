import { rinka } from "rinka/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [rinka({ prefix: "app" })],
});

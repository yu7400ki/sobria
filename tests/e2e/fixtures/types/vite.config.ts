import { sobria } from "sobria/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sobria({ prefix: "app" })],
});

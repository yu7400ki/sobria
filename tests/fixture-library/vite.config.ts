import { sobria } from "sobria/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sobria({ prefix: "acme", library: true })],
});

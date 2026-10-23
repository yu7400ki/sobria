import { svelte } from "@sveltejs/vite-plugin-svelte";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: "node", include: ["node/**/*.test.ts"] } },
      {
        plugins: [svelte()],
        test: {
          name: "e2e",
          globalSetup: ["global-setup.ts"],
          include: ["e2e/**/*.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});

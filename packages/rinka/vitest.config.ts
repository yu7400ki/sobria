import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import { oxc } from "./src/build/entries.ts";

const types = (name: string) => ({
  oxc: { jsx: oxc.jsx },
  test: {
    name: `types-${name}`,
    typecheck: {
      enabled: true,
      only: true,
      include: [`test/types/${name}/**/*.test-d.{ts,tsx}`],
      tsconfig: `test/types/${name}/tsconfig.json`,
    },
  },
});

export default defineConfig({
  test: {
    projects: [
      { test: { name: "node", include: ["test/node/**/*.test.ts"] } },
      {
        test: {
          name: "browser",
          include: ["test/browser/**/*.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
      types("client"),
      types("server"),
      types("shared"),
    ],
  },
});

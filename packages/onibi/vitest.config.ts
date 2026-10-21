import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/** 型の単体テストのプロジェクト。`test/types/<name>/tsconfig.json` の条件で型を解決する。 */
const types = (name: string) => ({
  test: {
    name: `types-${name}`,
    include: [],
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
    passWithNoTests: true,
    projects: [
      { test: { name: "node", environment: "node", include: ["test/node/**/*.test.ts"] } },
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

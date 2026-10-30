import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { domNameSources } from "../../scripts/dom-names.ts";

describe("生成した名前の一覧", () => {
  it("コミットしたファイルは、DOM の型定義から生成した内容と一致する", () => {
    for (const [path, content] of Object.entries(domNameSources())) {
      expect(
        readFileSync(resolve(import.meta.dirname, "../..", path), "utf8"),
        `${path} が古いので、pnpm --filter sobria generate を実行してください。`,
      ).toBe(content);
    }
  }, 30_000);
});

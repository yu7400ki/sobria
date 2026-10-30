import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashedFnModule, isServerFnSource, serverFnModules } from "../../src/build/server-fns.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("サーバー関数の ID のモジュールの部分", () => {
  it("ファイルのパスの SHA-256 を base64url にした値の先頭 10 文字に、m を付ける", () => {
    expect(hashedFnModule("src/lib/a.ts")).toBe("mMZVHZM5VRS");
    expect(hashedFnModule("src/lib/b.ts")).not.toBe(hashedFnModule("src/lib/a.ts"));
  });
});

describe("サーバー関数を定義できるファイル", () => {
  it("src/ の中の .ts、.tsx、.js、.jsx のファイルで、型宣言のファイルと、正規化されていないパスと、\\ を含むパスを除く", () => {
    expect(isServerFnSource("src/lib/a.ts")).toBe(true);
    expect(isServerFnSource("src/.server/a.tsx")).toBe(true);
    expect(isServerFnSource("test/a.ts")).toBe(false);
    expect(isServerFnSource("src/env.d.ts")).toBe(false);
    expect(isServerFnSource("src/a.css")).toBe(false);
    expect(isServerFnSource("src/../test/a.ts")).toBe(false);
    expect(isServerFnSource("src/./a.ts")).toBe(false);
    expect(isServerFnSource("src/..\\..\\a.ts")).toBe(false);
  });

  it("走査は、src/ の中でサーバー関数を定義したファイルを、パスの順に返す", () => {
    const root = mkdtempSync(join(tmpdir(), "sobria-fns-"));
    roots.push(root);
    const files: Record<string, string> = {
      "src/lib/a.ts":
        'import { defineServerFn } from "sobria/server";\nexport const a = defineServerFn(() => 1);\n',
      "src/.server/b.ts":
        'import { defineServerFn } from "sobria/server";\nexport const b = defineServerFn(() => 1);\n',
      "src/lib/plain.ts": "export const defineServerFn = 1;\n",
      "src/lib/middleware.ts":
        'import { defineMiddleware } from "sobria/server";\n// defineServerFn\nexport const m = defineMiddleware(async (_c, next) => next());\n',
      "test/c.ts":
        'import { defineServerFn } from "sobria/server";\nexport const c = defineServerFn(() => 1);\n',
    };
    for (const [file, code] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), code);
    }
    expect(serverFnModules(root)).toEqual(["src/.server/b.ts", "src/lib/a.ts"]);
  });
});

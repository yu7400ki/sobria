import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { hashedFnModule, isServerFnSource, serverFnModules } from "../../src/build/server-fns.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** サーバー関数 `name` を 1 つだけ定義するモジュールのソースを返す。 */
const serverFnSource = (name: string) =>
  `import { defineServerFn } from "sobria/server";\nexport const ${name} = defineServerFn(() => 1);\n`;

/** パス `path` のファイルかディレクトリが無いことを示す、Node と同じ `code` のエラーを返す。 */
const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });

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

  it("走査は、走査の途中で削除されたファイルとディレクトリを、結果に含めない", async () => {
    const root = mkdtempSync(join(tmpdir(), "sobria-fns-"));
    roots.push(root);
    for (const file of ["src/lib/a.ts", "src/lib/b.ts", "src/gone/c.ts"]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), serverFnSource(basename(file, ".ts")));
    }
    // ディレクトリの一覧を読んだ後に、src/gone/ と src/lib/b.ts が削除された状態を再現する
    vi.doMock("node:fs", async (importOriginal) => {
      const fs = await importOriginal<typeof import("node:fs")>();
      return {
        ...fs,
        readdirSync: ((path: string, options: object) => {
          if (path.endsWith("gone")) throw missing(path);
          return fs.readdirSync(path, options);
        }) as typeof fs.readdirSync,
        readFileSync: ((path: string, options: object) => {
          if (path.endsWith("b.ts")) throw missing(path);
          return fs.readFileSync(path, options);
        }) as typeof fs.readFileSync,
      };
    });
    vi.resetModules();
    try {
      const scan = await import("../../src/build/server-fns.ts");
      expect(scan.serverFnModules(root)).toEqual(["src/lib/a.ts"]);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

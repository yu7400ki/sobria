import { describe, expect, it } from "vitest";

import { CompileError, transformSource } from "../../src/build/compiler.ts";
import { devPath, directUrl } from "../../src/build/paths.ts";
import { sheetModule } from "../../src/build/sheets.ts";
import { serverSheet, sheetHref } from "../../src/server/styles.ts";

/** `.ts` のモジュール `src/lib/a.ts` として `code` を変換したコードを返す。 */
const transform = (code: string, client: boolean) =>
  transformSource(code, { id: "src/lib/a.ts", file: "src/lib/a.ts", lang: "ts", client }).code;

describe("with { type: 'css' } の書き換え", () => {
  it("with { type: 'css' } の import を、シートのモジュールの指定子にし、import の属性を削除する", () => {
    for (const client of [true, false]) {
      expect(transform('import tw from "../styles/app.css" with { type: "css" };', client)).toBe(
        'import tw from "../styles/app.css?rinka-sheet";',
      );
    }
  });

  it("with { type: 'css' } の再エクスポートも書き換え、属性の中のコメントの } に影響されない", () => {
    expect(
      transform(
        'export { default } from "./app.css" with { type: "css" /* } */ };\nexport * from "./b.css" with { type: "css" }',
        false,
      ),
    ).toBe('export { default } from "./app.css?rinka-sheet";\nexport * from "./b.css?rinka-sheet"');
  });

  it("type: 'css' を指定した動的な import は、ビルドのエラーにする", () => {
    expect(() =>
      transform('const s = import("./a.css", { with: { type: "css" } });', true),
    ).toThrow(CompileError);
  });

  it("属性の無い import と、type が css でない import は変更しない", () => {
    const code = 'import "./a.css";\nimport data from "./b.json" with { type: "json" };';
    expect(transform(code, true)).toBe(code);
  });
});

describe("シートのモジュール", () => {
  it("クライアントのモジュールは、?inline の CSS からシートを作成して default export し、?inline の更新で同じシートを差し替える", () => {
    const code = sheetModule("/src/a b.css", "serve", true);
    expect(code).toContain('import { createSheet, updateSheet } from "rinka/internal";');
    expect(code).toContain('import css from "/src/a b.css?inline";');
    expect(code).toContain("const sheet = createSheet(css);");
    expect(code).toContain('import.meta.hot.accept("/src/a b.css?inline",');
    expect(code).toContain("updateSheet(sheet, module.default)");
    expect(code).toContain("export default sheet;");
  });

  it("サーバーのモジュールは、<link> の URL からシートの情報を作成して default export する", () => {
    const code = sheetModule("/src/a.css", "serve", false);
    expect(code).toContain('import { serverSheet } from "rinka/internal";');
    expect(code).toContain('export default serverSheet("/src/a.css?direct");');
    expect(code).not.toContain("rinka.sheet");
  });
});

describe("本番のシートのモジュール", () => {
  it("クライアントのモジュールは、?url の CSS を fetch して作成したシートを default export する", () => {
    const code = sheetModule("/src/a.css", "app", true);
    expect(code).toContain('import { loadSheet } from "rinka/internal";');
    expect(code).toContain('import url from "/src/a.css?url";');
    expect(code).toContain("export default await loadSheet(url);");
  });

  it("サーバーのモジュールは、?url の URL からシートの情報を作成する", () => {
    const code = sheetModule("/src/a.css", "app", false);
    expect(code).toContain('import href from "/src/a.css?url";');
    expect(code).toContain("export default serverSheet(href);");
  });
});

describe("ライブラリのビルドのシートのモジュール", () => {
  it("?inline の CSS から作成したシートを default export し、HMR のコードを含まない", () => {
    const code = sheetModule("/src/a.css", "library", true);
    expect(code).toContain(`import { createSheet } from "rinka/internal";`);
    expect(code).toContain(`import css from "/src/a.css?inline";`);
    expect(code).toContain("export default createSheet(css);");
    expect(code).not.toContain("import.meta.hot");
  });
});

describe("開発サーバーのパスと URL", () => {
  it("ルートの中のファイルはルートからのパスに、ルートの外のファイルは /@fs/ のパスにする", () => {
    expect(devPath("/root/src/app.css", "/root")).toBe("/src/app.css");
    expect(devPath("/lib/app.css", "/root")).toBe("/@fs/lib/app.css");
  });

  it("?direct の URL は、URL に使用できない文字をパーセントエンコードする", () => {
    expect(directUrl("/src/a b#c.css")).toBe("/src/a%20b%23c.css?direct");
  });
});

describe("サーバーのシート", () => {
  it("<link> に出力する URL を、シートの情報に持つ", () => {
    expect(Reflect.get(serverSheet("/a.css?direct"), sheetHref)).toBe("/a.css?direct");
  });
});

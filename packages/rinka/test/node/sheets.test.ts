import { describe, expect, it } from "vitest";

import { CompileError, transformSource } from "../../src/build/compiler.ts";
import { sheetModule } from "../../src/build/sheets.ts";

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
  it("クライアントのモジュールは、?inline の CSS から作成したシートを default export し、?inline の更新で同じシートの中身を差し替える", () => {
    const code = sheetModule("/root/src/styles/app.css", "/root", true);
    expect(code).toContain('import css from "/src/styles/app.css?inline";');
    expect(code).toContain("sheet.replaceSync(css);");
    expect(code).toContain('import.meta.hot.accept("/src/styles/app.css?inline",');
    expect(code).toContain("export default sheet;");
  });

  it("サーバーのモジュールは、?direct を付与した URL を、シートの情報として default export する", () => {
    expect(sheetModule("/root/src/styles/app.css", "/root", false)).toContain(
      '"href":"/src/styles/app.css?direct"',
    );
  });

  it("<link> の URL だけ、使用できない文字をパーセントエンコードし、?inline の指定子はエンコードしない", () => {
    expect(sheetModule("/root/src/a b#c.css", "/root", false)).toContain(
      '"href":"/src/a%20b%23c.css?direct"',
    );
    expect(sheetModule("/root/src/a b.css", "/root", true)).toContain(
      'import css from "/src/a b.css?inline";',
    );
  });

  it("ルートの外の CSS は、/@fs/ の URL にする", () => {
    expect(sheetModule("/lib/app.css", "/root", false)).toContain(
      '"href":"/@fs/lib/app.css?direct"',
    );
  });
});

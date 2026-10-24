import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  apiReferenceDir,
  apiReferenceSources,
  entriesOf,
  referenceSources,
} from "../scripts/api-reference.ts";

/** 型定義とドキュメントコメントの書き方を一通り含む、見本のパッケージのディレクトリである。 */
const fixture = resolve(import.meta.dirname, "fixtures/api-package");

describe("API のリファレンスの生成", () => {
  const sources = referenceSources(fixture, resolve(fixture, "tsconfig.json"));
  const section = (slug: string, name: string) =>
    (sources[slug] ?? "").split(/(?=^## )/m).find((part) => part.startsWith(`## ${name}\n`));

  it("型定義を持つエントリーポイントごとにページを作成し、jsx-runtime を除く", () => {
    expect(entriesOf(fixture).map((entry) => entry.specifier)).toEqual(["fixture", "fixture/tool"]);
    expect(Object.keys(sources)).toEqual(["fixture", "tool"]);
  });

  it("環境で説明と宣言が同じ export は、環境を明記せずに 1 回だけ出力する", () => {
    expect(section("fixture", "same")).toBe(
      "## same\n\n値を受け取る。\n\n```ts\nfunction same(value: Local): void;\n\ninterface Local {\n  readonly name: string;\n}\n```\n\n",
    );
  });

  it("環境で説明が異なる export は、環境ごとの説明を併記し、同じ宣言は 1 回だけ出力する", () => {
    expect(section("fixture", "differ")).toBe(
      "## differ\n\n- 要素のファイル：ブラウザで実行する。\n- サーバーのファイル：何も実行せずに戻る。\n\n```ts\nconst differ: () => void;\n```\n\n",
    );
  });

  it("一部の環境にだけある export は、説明と宣言に環境を明記する", () => {
    expect(section("fixture", "onlyClient")).toBe(
      "## onlyClient\n\n- 要素のファイル：ブラウザにだけある値である。\n\n```ts\n// 要素のファイル\nconst onlyClient: number;\n```\n\n",
    );
  });

  it("ほかのパッケージから再 export した値は、再 export の元のモジュールの指定子を出力する", () => {
    expect(section("fixture", "Hono")).toBe(
      "## Hono\n\n`hono` の `Hono` を、`fixture` から再 export する。\n",
    );
  });

  it("export が無い型定義の環境は、エントリーポイントを使用できない環境として扱う", () => {
    expect(section("tool", "Method")).toContain("## Method\n\nメソッドを表す。\n");
  });

  it("typeof で参照する、export しない const の宣言を展開する", () => {
    expect(section("tool", "Method")).toContain(
      'type Method = (typeof methods)[number];\n\nconst methods: readonly ["GET", "POST"];',
    );
  });

  it("@internal のタグを付与した型は、その型も、その中で参照する型も展開しない", () => {
    const uses = section("tool", "Uses");
    expect(uses).toContain("readonly hidden: Hidden;");
    expect(uses).not.toContain("interface Hidden");
    expect(uses).not.toContain("interface Detail");
  });

  it("インラインコードの外の、MDX で解析される文字を文字参照にする", () => {
    expect(section("tool", "Uses")).toContain("`<head>` に &#123;x&#125; &amp; y を出力する。");
  });

  it("オーバーロードは、宣言ごとのドキュメントコメントを段落にする", () => {
    expect(section("tool", "overload")).toContain("1 つ目の形である。\n\n2 つ目の形である。");
  });

  it("リファレンスに出力できないタグを付与した export があれば、エラーにする", () => {
    const tagged = resolve(import.meta.dirname, "fixtures/api-tagged");
    expect(() => referenceSources(tagged, resolve(tagged, "tsconfig.json"))).toThrow(
      "old のドキュメントコメントのタグ deprecated は、リファレンスに出力できません。",
    );
  });

  it("エントリーポイントに環境の条件が 2 つ以上あれば、エラーにする", () => {
    expect(() => entriesOf(resolve(import.meta.dirname, "fixtures/api-dual"))).toThrow(
      ". の条件が 2 つ以上あります。",
    );
  });
});

describe("API のリファレンス", () => {
  it("コミットしたファイルは、rinka の型定義から生成したファイルの一覧と内容に一致する", async () => {
    const sources = await apiReferenceSources();
    expect(
      readdirSync(resolve(import.meta.dirname, "..", apiReferenceDir))
        .map((file) => `${apiReferenceDir}/${file}`)
        .toSorted(),
      "生成しないファイルがあるので、pnpm --filter @rinka/docs generate を実行してください。",
    ).toEqual(Object.keys(sources).toSorted());
    for (const [path, content] of Object.entries(sources)) {
      expect(
        readFileSync(resolve(import.meta.dirname, "..", path), "utf8"),
        `${path} が古いので、pnpm --filter @rinka/docs generate を実行してください。`,
      ).toBe(content);
    }
  }, 30_000);
});

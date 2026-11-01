import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sobria } from "sobria/vite";
import { createBuilder, createLogger, resolveConfig } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFixture } from "./production.ts";

/** テスト用のライブラリのルートである。 */
const root = fileURLToPath(new URL("../../fixture-library", import.meta.url));

let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "sobria-library-"));
  await buildFixture(root, outDir, { prefix: "acme", library: true });
}, 120_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe("library: true のビルド", () => {
  it("要素ごとに <タグ名>.js を出力し、共通のコードを chunks/ に分割して、CSS のファイルとサーバーの出力を出力しない", async () => {
    const files = (await readdir(outDir, { recursive: true })).map((file) =>
      file.replaceAll("\\", "/"),
    );
    expect(files.filter((file) => !/^(chunks|assets)\//.test(file)).toSorted()).toEqual([
      "acme-badge.js",
      "acme-counter.js",
      "acme-rating.js",
      "assets",
      "chunks",
      "custom-elements.json",
    ]);
    expect(files.some((file) => /^chunks\/.+\.js$/.test(file))).toBe(true);
    expect(files.filter((file) => file.endsWith(".css"))).toEqual([]);
  });

  it("出力は sobria と共通のコードを相対パスで import し、CSS の url() をモジュールからの相対パスで解決する", async () => {
    const files = (await readdir(outDir, { recursive: true })).filter((file) =>
      file.endsWith(".js"),
    );
    const code = (
      await Promise.all(files.map((file) => readFile(join(outDir, file), "utf8")))
    ).join("\n");
    const specifiers = [...code.matchAll(/\bfrom\s*["'`]([^"'`]+)["'`]/g)].map(
      ([, specifier]) => specifier!,
    );
    expect(specifiers.filter((specifier) => !specifier.startsWith("."))).toEqual([]);
    const badge = await readFile(join(outDir, "acme-badge.js"), "utf8");
    expect(badge).not.toContain("/assets/");
    expect(badge).toContain("import.meta.url");
  });

  it("要素を記述した Custom Elements Manifest を、package.json のディレクトリからのパスで出力する", async () => {
    const { manifest } = await buildCopy({ prefix: "acme" });
    const label = { type: { text: "string" }, description: "バッジに表示する文字列である。" };
    const like = "ボタンを押したときに、1 を足した数で呼ぶ。";
    expect(manifest).toEqual({
      schemaVersion: "2.1.0",
      modules: [
        module("acme-badge", "Badge", {
          description: "ラベルとスロットの内容を表示する。",
          attributes: [{ name: "label", fieldName: "label", ...label }],
          slots: [{ name: "" }],
          members: [{ kind: "field", name: "label", ...label }],
          cssParts: [{ name: "badge" }],
          cssProperties: [{ name: "--badge-color", description: "文字の色である。" }],
        }),
        module("acme-counter", "Counter", {
          attributes: [{ name: "count", fieldName: "count", type: { text: "number" } }],
          events: [
            { name: "like-click", type: { text: "CustomEvent<number>" }, description: like },
          ],
          members: [
            { kind: "field", name: "count", type: { text: "number" } },
            {
              kind: "field",
              name: "onLikeClick",
              type: { text: "(count: number) => void" },
              description: like,
            },
            {
              kind: "method",
              name: "focusButton",
              parameters: [],
              return: { type: { text: "void" } },
              description: "ボタンをフォーカスする。",
            },
          ],
        }),
        module("acme-rating", "Rating", {
          attributes: [
            { name: "required", fieldName: "required", type: { text: "boolean" } },
            { name: "max", fieldName: "max", type: { text: "number" } },
            { name: "name", type: { text: "string" } },
            { name: "disabled", type: { text: "boolean" } },
          ],
          members: [
            { kind: "field", name: "required", type: { text: "boolean" } },
            { kind: "field", name: "max", type: { text: "number" } },
          ],
        }),
      ],
    });
  }, 120_000);

  it("接頭辞がデフォルト値の sobria なら、警告を出力する", async () => {
    const { warnings } = await buildCopy({ prefix: "sobria" });
    expect(warnings.join("\n")).toMatch(/接頭辞/);
  }, 120_000);

  it("package.json の customElements が出力したマニフェストを指していれば、./ で始まる書き方でも警告を出力しない", async () => {
    const { warnings } = await buildCopy({ prefix: "acme" }, (json) => {
      json["customElements"] = "./dist/custom-elements.json";
    });
    expect(warnings).toEqual([]);
  }, 120_000);

  it.each([
    ["無ければ", undefined],
    ["ほかのパスを指していれば", "lib/custom-elements.json"],
  ])(
    "package.json の customElements が%s、記述するパスを示して警告を出力する",
    async (_, value) => {
      const { warnings } = await buildCopy({ prefix: "acme" }, (json) => {
        json["customElements"] = value;
      });
      expect(warnings.join("\n")).toContain('"customElements": "dist/custom-elements.json"');
    },
    120_000,
  );

  it("ライブラリの要素がサーバー関数を定義したファイルを import すると、そのファイルを示して警告を出力する", async () => {
    const { warnings } = await buildCopy(
      { prefix: "acme" },
      (json) => {
        json["customElements"] = "dist/custom-elements.json";
      },
      {
        "src/fns.ts": `import { defineServerFn } from "sobria/server";
export const like = defineServerFn(() => null);
`,
        "src/elements/liker.tsx": `import { like } from "../fns.ts";
export default function Liker() {
  return <button type="button">{String(typeof like)}</button>;
}
`,
      },
    );
    expect(warnings.join("\n")).toContain("src/fns.ts");
  }, 120_000);

  it("vite preview は、出力先をそのまま配信する", async () => {
    const config = await resolveConfig(
      {
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [sobria({ prefix: "acme", outDir, library: true })],
      },
      "serve",
      "production",
      "production",
      true,
    );
    expect(config.build.outDir).toBe(outDir);
  });
});

/**
 * テスト用のライブラリのコピーを、`library: true` と `options` でビルドし、出力した警告と、出力した Custom Elements Manifest を返す。
 * `edit` は、コピーの package.json を書き換える。`files` は、コピーのルートからの相対パスごとに、追加するファイルの内容を持つ。出力先は、コピーの中の `dist` である。
 */
async function buildCopy(
  options: { prefix: string },
  edit?: (json: Record<string, unknown>) => void,
  files: Readonly<Record<string, string>> = {},
): Promise<{ warnings: string[]; manifest: unknown }> {
  // ビルドは .sobria/ に書き込むので、ライブラリのコピーをビルドする。sobria を解決できるように、コピーは tests/e2e の中に置く
  const copy = await mkdtemp(fileURLToPath(new URL("../.sobria-tmp-library-", import.meta.url)));
  await cp(root, copy, {
    recursive: true,
    filter: (source) => ![".sobria", "dist", "types", "node_modules"].includes(basename(source)),
  });
  if (edit) {
    const path = join(copy, "package.json");
    const json: Record<string, unknown> = JSON.parse(await readFile(path, "utf8"));
    edit(json);
    await writeFile(path, JSON.stringify(json));
  }
  await Promise.all(
    Object.entries(files).map(([file, content]) => writeFile(join(copy, file), content)),
  );
  const warnings: string[] = [];
  const logger = createLogger("warn");
  logger.warn = (message) => {
    warnings.push(message);
  };
  try {
    const builder = await createBuilder({
      root: copy,
      configFile: false,
      customLogger: logger,
      // Rolldown がプラグインの所要時間を警告するかどうかは、マシンの負荷で変わるので、この警告を無効にする
      build: { rolldownOptions: { checks: { bundlerTimings: false } } },
      plugins: [sobria({ ...options, library: true })],
    });
    await builder.buildApp();
    const manifest: unknown = JSON.parse(
      await readFile(join(copy, "dist", "custom-elements.json"), "utf8"),
    );
    return { warnings, manifest };
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

/** マニフェストの、タグ名 `tag` の要素のモジュール `dist/<タグ名>.js` の記述を返す。 */
const module = (tag: string, name: string, declaration: object) => ({
  kind: "javascript-module",
  path: `dist/${tag}.js`,
  declarations: [{ kind: "class", customElement: true, tagName: tag, name, ...declaration }],
  exports: [
    {
      kind: "custom-element-definition",
      name: tag,
      declaration: { name, module: `dist/${tag}.js` },
    },
  ],
});

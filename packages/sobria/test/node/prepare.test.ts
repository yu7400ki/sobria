import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { preparedFiles, writePrepared } from "../../src/build/prepare.ts";

/** 生成の入力にするアプリのルートである。 */
const root = fileURLToPath(new URL("../fixtures/prepare", import.meta.url));

/** `root` のアプリから生成したファイルを返す。 */
const prepare = (options: { prefix?: string; globalJSX?: boolean; root?: string } = {}) =>
  preparedFiles({
    root: options.root ?? root,
    prefix: options.prefix ?? "app",
    elementsDir: join(options.root ?? root, "src/elements"),
    extensions: [],
    globalJSX: options.globalJSX ?? true,
  });

/** 生成したファイルのうち、名前が `name` のファイルの内容を返す。 */
const fileOf = (name: string, options?: Parameters<typeof prepare>[0]) => {
  const content = prepare(options).get(name);
  if (content === undefined) throw new Error(`${name} が生成されていません。`);
  return content;
};

describe("生成するファイル", () => {
  it(".sobria/ に、型宣言と 3 つの tsconfig を生成する", () => {
    expect([...prepare().keys()].toSorted()).toEqual([
      "elements.d.ts",
      "env.d.ts",
      "routes.d.ts",
      "tsconfig.elements.json",
      "tsconfig.server.json",
      "tsconfig.shared.json",
    ]);
  });
});

describe("routes.d.ts", () => {
  it("ページと route.ts のファイルの形のパスを、グループを除いてキーにし、パラメータとキャッチオールの名前を string にする", () => {
    const content = fileOf("routes.d.ts");
    expect(content).toContain('declare module "sobria/router" {');
    expect(content).toContain('    "/": {};');
    expect(content).toContain('    "/docs/[...slug]": { slug: string };');
    expect(content).toContain('    "/users/[id]": { id: string };');
    expect(content).toContain('    "/api": {};');
    expect(content).toContain('    "/api/items/[id]": { id: string };');
    expect(content).not.toContain("(shop)");
  });

  it("route.ts のファイルの形のパスごとに、Hono のパスを RouteHandlerPaths に出力し、ページのパスは出力しない", () => {
    const content = fileOf("routes.d.ts");
    const start = content.indexOf("interface RouteHandlerPaths {");
    const paths = content.slice(start, content.indexOf("\n  }", start));
    expect(paths).toContain('    "/api": "/api";');
    expect(paths).toContain('    "/api/items/[id]": "/api/items/:id";');
    expect(paths).toContain('    "/files/[...path]": "/files/:path{.+}";');
    expect(paths).not.toContain("/users");
    expect(paths).not.toContain('"/"');
  });
});

describe("elements.d.ts", () => {
  it("要素のファイルのタグを、ElementRef の型で HTMLElementTagNameMap に追加する", () => {
    const content = fileOf("elements.d.ts");
    expect(content).toContain('import type { ElementRef } from "sobria";');
    expect(content).toContain('import type E0 from "../src/elements/dialog/index.tsx";');
    expect(content).toContain('import type E1 from "../src/elements/user-card.tsx";');
    expect(content).toContain('    "app-dialog": ElementRef<typeof E0>;');
    expect(content).toContain('    "app-user-card": ElementRef<typeof E1>;');
    expect(content).not.toContain("_shared");
    expect(content).not.toContain("format");
  });

  it("タグ名には、設定した接頭辞を付ける", () => {
    expect(fileOf("elements.d.ts", { prefix: "my" })).toContain('"my-user-card"');
  });
});

describe("env.d.ts", () => {
  it("トップレベルに import を持たないファイルにし、*.css の default export を CSSStyleSheet にする", () => {
    const content = fileOf("env.d.ts");
    expect(content).not.toMatch(/^(import|export) /m);
    expect(content).toContain('declare module "*.css" {');
    expect(content).toContain("const sheet: CSSStyleSheet;");
  });

  it("Vite の ImportMeta とアセットのモジュールの型を参照する", () => {
    expect(fileOf("env.d.ts")).toContain('/// <reference types="vite/client" />');
  });

  it("グローバルの JSX.Element を Slot にし、globalJSX が偽なら JSX の宣言を出力しない", () => {
    expect(fileOf("env.d.ts")).toContain('type Element = import("sobria").Slot;');
    expect(fileOf("env.d.ts", { globalJSX: false })).not.toContain("JSX");
  });
});

/** 生成した tsconfig のうち、プロジェクトが `name` のものを返す。 */
const config = (name: string, options?: Parameters<typeof prepare>[0]): unknown =>
  JSON.parse(fileOf(`tsconfig.${name}.json`, options));

/** 生成した tsconfig が、アプリの tsconfig.base.json より優先して指定する設定である。 */
const required = {
  module: "preserve",
  moduleResolution: "bundler",
  jsx: "react-jsx",
  jsxImportSource: "sobria",
  verbatimModuleSyntax: true,
  allowImportingTsExtensions: true,
  composite: true,
  emitDeclarationOnly: true,
  noEmit: false,
};

describe("tsconfig", () => {
  it("elements は、要素のディレクトリを sobria-client の条件で検査し、shared を参照する", () => {
    expect(config("elements")).toEqual({
      extends: ["sobria/tsconfig.json", "../tsconfig.base.json"],
      compilerOptions: {
        ...required,
        rootDir: "..",
        outDir: "out/elements",
        customConditions: ["sobria-client"],
      },
      include: ["../src/elements", "env.d.ts", "routes.d.ts", "elements.d.ts"],
      references: [{ path: "tsconfig.shared.json" }],
    });
  });

  it("server は、ルートのディレクトリを sobria-server の条件で検査し、elements と shared を参照する", () => {
    expect(config("server")).toEqual({
      extends: ["sobria/tsconfig.json", "../tsconfig.base.json"],
      compilerOptions: {
        ...required,
        rootDir: "..",
        outDir: "out/server",
        customConditions: ["sobria-server"],
      },
      include: ["../src/routes", "env.d.ts", "routes.d.ts"],
      references: [{ path: "tsconfig.elements.json" }, { path: "tsconfig.shared.json" }],
    });
  });

  it("shared は、src/ のうち要素とルートのディレクトリ以外を、sobria-shared と sobria-server の条件で検査する", () => {
    expect(config("shared")).toEqual({
      extends: ["sobria/tsconfig.json", "../tsconfig.base.json"],
      compilerOptions: {
        ...required,
        rootDir: "..",
        outDir: "out/shared",
        customConditions: ["sobria-shared", "sobria-server"],
      },
      include: ["../src", "env.d.ts", "routes.d.ts"],
      exclude: ["../src/elements", "../src/routes"],
    });
  });

  it("アプリに tsconfig.base.json が無ければ、sobria/tsconfig.json だけを extends する", () => {
    const app = mkdtempSync(join(tmpdir(), "sobria-prepare-"));
    try {
      expect(config("shared", { root: app })).toMatchObject({ extends: ["sobria/tsconfig.json"] });
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });
});

describe("書き込み", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it(".sobria/ に書き込み、内容が変わったファイルだけを書き直す", () => {
    const app = mkdtempSync(join(tmpdir(), "sobria-prepare-"));
    dirs.push(app);
    const first = new Map([
      ["a.d.ts", "a"],
      ["b.d.ts", "b"],
    ]);
    expect(writePrepared(app, first)).toEqual(["a.d.ts", "b.d.ts"]);
    expect(readFileSync(join(app, ".sobria/a.d.ts"), "utf8")).toBe("a");
    const before = statSync(join(app, ".sobria/a.d.ts")).mtimeMs;
    writeFileSync(join(app, ".sobria/b.d.ts"), "old");
    expect(
      writePrepared(
        app,
        new Map([
          ["a.d.ts", "a"],
          ["b.d.ts", "b"],
        ]),
      ),
    ).toEqual(["b.d.ts"]);
    expect(statSync(join(app, ".sobria/a.d.ts")).mtimeMs).toBe(before);
    expect(readFileSync(join(app, ".sobria/b.d.ts"), "utf8")).toBe("b");
  });
});

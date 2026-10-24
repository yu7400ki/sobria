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
  it(".rinka/ に、型宣言と 3 つの tsconfig を生成する", () => {
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
  it("ページのファイルの形のパスを、グループを除いてキーにし、パラメータとキャッチオールの名前を string にする", () => {
    const content = fileOf("routes.d.ts");
    expect(content).toContain('declare module "rinka/router" {');
    expect(content).toContain('    "/": {};');
    expect(content).toContain('    "/docs/[...slug]": { slug: string };');
    expect(content).toContain('    "/users/[id]": { id: string };');
    expect(content).not.toContain("/api");
    expect(content).not.toContain("(shop)");
  });
});

describe("elements.d.ts", () => {
  it("要素のファイルのタグを、ElementRef の型で HTMLElementTagNameMap に追加する", () => {
    const content = fileOf("elements.d.ts");
    expect(content).toContain('import type { ElementRef } from "rinka";');
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

  it("Vite の ImportMeta の型を参照する", () => {
    expect(fileOf("env.d.ts")).toContain('/// <reference types="vite/types/importMeta.d.ts" />');
  });

  it("グローバルの JSX.Element を Slot にし、globalJSX が偽なら JSX の宣言を出力しない", () => {
    expect(fileOf("env.d.ts")).toContain('type Element = import("rinka").Slot;');
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
  jsxImportSource: "rinka",
  verbatimModuleSyntax: true,
  allowImportingTsExtensions: true,
  composite: true,
  emitDeclarationOnly: true,
  noEmit: false,
};

describe("tsconfig", () => {
  it("elements は、要素のディレクトリを rinka-client の条件で検査し、shared を参照する", () => {
    expect(config("elements")).toEqual({
      extends: ["rinka/tsconfig.json", "../tsconfig.base.json"],
      compilerOptions: {
        ...required,
        rootDir: "..",
        outDir: "out/elements",
        customConditions: ["rinka-client"],
      },
      include: ["../src/elements", "env.d.ts", "elements.d.ts", "routes.d.ts"],
      references: [{ path: "tsconfig.shared.json" }],
    });
  });

  it("server は、ルートのディレクトリを rinka-server の条件で検査し、elements と shared を参照する", () => {
    expect(config("server")).toEqual({
      extends: ["rinka/tsconfig.json", "../tsconfig.base.json"],
      compilerOptions: {
        ...required,
        rootDir: "..",
        outDir: "out/server",
        customConditions: ["rinka-server"],
      },
      include: ["../src/routes", "env.d.ts", "routes.d.ts"],
      references: [{ path: "tsconfig.elements.json" }, { path: "tsconfig.shared.json" }],
    });
  });

  it("shared は、src/ のうち要素とルートのディレクトリ以外を、rinka-shared と rinka-server の条件で検査する", () => {
    expect(config("shared")).toEqual({
      extends: ["rinka/tsconfig.json", "../tsconfig.base.json"],
      compilerOptions: {
        ...required,
        rootDir: "..",
        outDir: "out/shared",
        customConditions: ["rinka-shared", "rinka-server"],
      },
      include: ["../src", "env.d.ts"],
      exclude: ["../src/elements", "../src/routes"],
    });
  });

  it("アプリに tsconfig.base.json が無ければ、rinka/tsconfig.json だけを extends する", () => {
    const app = mkdtempSync(join(tmpdir(), "rinka-prepare-"));
    try {
      expect(config("shared", { root: app })).toMatchObject({ extends: ["rinka/tsconfig.json"] });
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

  it(".rinka/ に書き込み、内容が変わったファイルだけを書き直す", () => {
    const app = mkdtempSync(join(tmpdir(), "rinka-prepare-"));
    dirs.push(app);
    const first = new Map([
      ["a.d.ts", "a"],
      ["b.d.ts", "b"],
    ]);
    expect(writePrepared(app, first)).toEqual(["a.d.ts", "b.d.ts"]);
    expect(readFileSync(join(app, ".rinka/a.d.ts"), "utf8")).toBe("a");
    const before = statSync(join(app, ".rinka/a.d.ts")).mtimeMs;
    writeFileSync(join(app, ".rinka/b.d.ts"), "old");
    expect(
      writePrepared(
        app,
        new Map([
          ["a.d.ts", "a"],
          ["b.d.ts", "b"],
        ]),
      ),
    ).toEqual(["b.d.ts"]);
    expect(statSync(join(app, ".rinka/a.d.ts")).mtimeMs).toBe(before);
    expect(readFileSync(join(app, ".rinka/b.d.ts"), "utf8")).toBe("b");
  });
});

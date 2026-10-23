import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const oxlint = join(
  dirname(createRequire(import.meta.url).resolve("oxlint/package.json")),
  "bin",
  "oxlint",
);

/** パッケージの oxlint の設定を一時的なディレクトリにコピーする。テストのファイルは、このディレクトリの `src/` に配置する。 */
const workspace = mkdtempSync(join(root, ".lint-probe-"));
for (const file of ["oxlint.config.ts", "oxlint-plugin.ts"]) {
  copyFileSync(join(root, file), join(workspace, file));
}

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** oxlint の報告の code を、期待値で使用する短い名前に対応付ける。 */
const rules = new Map([
  ["eslint(no-restricted-imports)", "import"],
  ["eslint(no-undef)", "global"],
  ["unicorn(prefer-node-protocol)", "node"],
  ["rinka(no-static-wire-codec)", "wire-codec"],
  ["import(no-cycle)", "cycle"],
  ["rinka(no-transfer-key-literal)", "key"],
  ["rinka(no-directional-insert)", "insert"],
  ["rinka(no-entry-literal)", "entry"],
  ["rinka(no-receiver-literal)", "receiver"],
  ["rinka(no-marker-attribute-literal)", "marker"],
  ["rinka(no-output-dir-literal)", "output-dir"],
  ["rinka(no-reserved-path-literal)", "reserved-path"],
]);

type Diagnostic = { code: string; labels: { span: { line: number } }[] };

/** 各行に 1 つの文を配置したファイルを `src/` に作成し、検査する規則の報告を、行の番号と規則の名前の組で返す。 */
function reports(path: string, lines: string[]): [number, string][] {
  mkdirSync(join(workspace, dirname(path)), { recursive: true });
  writeFileSync(join(workspace, path), `${lines.join("\n")}\n`);
  let output: string;
  try {
    output = execFileSync(process.execPath, [oxlint, "-f", "json", path], {
      cwd: workspace,
      encoding: "utf8",
    });
  } catch (error) {
    output = (error as { stdout: string }).stdout;
  }
  const { diagnostics } = JSON.parse(output) as { diagnostics: Diagnostic[] };
  return diagnostics
    .flatMap((d): [number, string][] => {
      const rule = rules.get(d.code);
      const line = d.labels[0]?.span.line;
      return rule === undefined || line === undefined ? [] : [[line, rule]];
    })
    .toSorted(([a], [b]) => a - b);
}

describe("src/ の lint の規則", () => {
  it("src/shared/ は、client、server、build、rinka、seroval、Node.js の組み込みモジュール、実行環境に固有のグローバル、props の名前の一覧の値を参照できない", () => {
    expect(
      reports("src/shared/probe.ts", [
        'import "../client/effect.ts";',
        'import "../../src/server/wire.ts";',
        'import "./../client/effect.ts";',
        'import "rinka";',
        'import "node:path";',
        'import "./prop-names.ts";',
        'import "./html-element-members.generated.js";',
        "export const a = document;",
        "export const b = IntersectionObserver;",
        "export const c = process;",
        'import "./names.ts";',
        "export const d = setTimeout;",
        'import type { HostAttribute } from "./prop-names.ts";',
        'import "../build/plugin.ts";',
        'import "seroval";',
      ]),
    ).toEqual([
      [1, "import"],
      [2, "import"],
      [3, "import"],
      [4, "import"],
      [5, "import"],
      [6, "import"],
      [7, "import"],
      [8, "global"],
      [9, "global"],
      [10, "global"],
      [14, "import"],
      [15, "import"],
    ]);
  });

  it("src/client/ は、server、build、rinka、seroval、Node.js の組み込みモジュール、props の名前の一覧の値を参照できず、wire-codec は型の import と動的な import() でだけ読み込め、ブラウザのグローバルを参照できる", () => {
    expect(
      reports("src/client/probe.ts", [
        'import "../server/wire.ts";',
        'import "../../src/server/wire.ts";',
        'import "rinka/server";',
        'import "node:fs";',
        'import "fs";',
        'import "../shared/prop-names.js";',
        "export const a = process;",
        "export const b = document;",
        "export const c = ElementInternals;",
        'import "../shared/expose-names.ts";',
        'import type { HostAttribute } from "../shared/prop-names.ts";',
        'import "../build/plugin.ts";',
        'import "seroval";',
        'import "./wire-codec.ts";',
        'export const d = () => import("./wire-codec.ts");',
        'export * from "./wire-codec.ts";',
        'export { toJSON } from "./wire-codec.ts";',
        'import type { toJSON as T } from "./wire-codec.ts";',
      ]),
    ).toEqual([
      [1, "import"],
      [2, "import"],
      [3, "import"],
      [4, "import"],
      [5, "node"],
      [6, "import"],
      [7, "global"],
      [12, "import"],
      [13, "import"],
      [14, "wire-codec"],
      [16, "wire-codec"],
      [17, "wire-codec"],
    ]);
  });

  it("src/server/ は、client、build、rinka、props の名前の一覧の値、seroval、ブラウザのグローバルを参照できず、Node.js の組み込みモジュールを参照できる", () => {
    expect(
      reports("src/server/probe.ts", [
        'import "../client/effect.ts";',
        'import "../../src/client/effect.ts";',
        'import "rinka";',
        "export const a = document;",
        "export const b = window;",
        'import "node:fs";',
        "export const c = process;",
        'import "../shared/prop-names.ts";',
        'import type { HostAttribute } from "../shared/prop-names.ts";',
        'import "../build/plugin.ts";',
        'import "seroval";',
      ]),
    ).toEqual([
      [1, "import"],
      [2, "import"],
      [3, "import"],
      [4, "global"],
      [5, "global"],
      [8, "import"],
      [10, "import"],
      [11, "import"],
    ]);
  });

  it("src/build/ は、client、server、rinka、seroval、vite の isRunnableDevEnvironment、ブラウザのグローバルを参照できず、shared、props の名前の一覧、Node.js の組み込みモジュール、ほかの vite の値を参照できる", () => {
    expect(
      reports("src/build/probe.ts", [
        'import "../client/effect.ts";',
        'import "../server/wire.ts";',
        'import "rinka";',
        'import "seroval";',
        "export const a = document;",
        'import "../shared/prop-names.ts";',
        'import "../shared/names.ts";',
        'import "node:fs";',
        "export const b = process;",
        'import { isRunnableDevEnvironment } from "vite";',
        'import { createServer } from "vite";',
      ]),
    ).toEqual([
      [1, "import"],
      [2, "import"],
      [3, "import"],
      [4, "import"],
      [5, "global"],
      [10, "import"],
    ]);
  });

  it("seroval を値として import できるのは src/server/wire.ts と src/client/wire-codec.ts で、src/shared/wire.ts は型だけを import できる", () => {
    expect(reports("src/server/wire.ts", ['import "seroval";'])).toEqual([]);
    expect(reports("src/client/wire-codec.ts", ['import "seroval";'])).toEqual([]);
    expect(
      reports("src/shared/wire.ts", [
        'import type { SerovalJSON } from "seroval";',
        'import { toJSON } from "seroval";',
      ]),
    ).toEqual([[2, "import"]]);
  });
});

describe("import の循環", () => {
  it("互いを import するモジュールを報告する", () => {
    expect(reports("src/client/cycle-b.ts", ['import "./cycle-a.ts";'])).toEqual([]);
    expect(reports("src/client/cycle-a.ts", ['import "./cycle-b.ts";'])).toEqual([[1, "cycle"]]);
  });
});

describe("値の受け渡しのキー", () => {
  it("src/ の中の、@ で始まる文字列のリテラルとテンプレートリテラルを報告し、読み込む先は報告しない", () => {
    expect(
      reports("src/server/keys.ts", [
        'export const a = "@b";',
        "export const b = `@c:${a}`;",
        'import "@solidjs/signals";',
        'export const c = () => import("@solidjs/signals");',
        'export { createMemo } from "@solidjs/signals";',
        'export const d = "x@b";',
        'export type M = typeof import("@solidjs/signals");',
        "export const e = (x: string) => import(`@solidjs/${x}`);",
        'declare module "@solidjs/signals" {}',
      ]),
    ).toEqual([
      [1, "key"],
      [2, "key"],
    ]);
  });

  it("src/shared/transfer-keys.ts のキーの定義は報告しない", () => {
    expect(reports("src/shared/transfer-keys.ts", ['export const a = "@b";'])).toEqual([]);
  });
});

describe("起動スクリプトの受け口の文字列", () => {
  it("src/ の中の、$rinka を含む文字列のリテラルとテンプレートリテラルを報告する", () => {
    expect(
      reports("src/server/receiver-use.ts", [
        'export const a = "$rinka.n";',
        "export const b = (x: string) => `<script>$rinka.d(${x})</script>`;",
        'export const d = "rinka";',
        'export const f = (x: string) => "$rinka" + x;',
      ]),
    ).toEqual([
      [1, "receiver"],
      [2, "receiver"],
      [4, "receiver"],
    ]);
  });

  it("src/server/bootstrap.ts は報告しない", () => {
    expect(reports("src/server/bootstrap.ts", ['export const a = "$rinka.n";'])).toEqual([]);
  });
});

describe("rinka が HTML に出力する目印の属性名", () => {
  it("src/ の中の、data-o に英小文字 1 文字が続く属性名か、data-rinka- で始まる属性名を含む文字列のリテラルとテンプレートリテラルを報告する", () => {
    expect(
      reports("src/client/marker-use.ts", [
        'export const a = "data-oh";',
        'export const b = (x: string) => `<p data-om="${x}">`;',
        'export const c = "data-other metadata-ok";',
        'export const d = "template[data-op=\\"1\\"]";',
        'export const e = (x: string) => `<p ${x} data-rinka-load="idle">`;',
        'export const f = "<style data-rinka-properties>";',
        "export const g = (x: string) => `<p${x}data-rinka-load>`;",
      ]),
    ).toEqual([
      [1, "marker"],
      [2, "marker"],
      [4, "marker"],
      [5, "marker"],
      [6, "marker"],
      [7, "marker"],
    ]);
  });

  it("src/shared/attributes.ts の属性名の定義は報告しない", () => {
    expect(
      reports("src/shared/attributes.ts", [
        'export const a = "data-oh";',
        'export const b = "data-rinka-load";',
      ]),
    ).toEqual([]);
  });
});

describe("MagicString の向きを持つ挿入", () => {
  it("src/build/ の中で、向きを持つ挿入のメソッドを呼ぶと報告する", () => {
    expect(
      reports("src/build/insert.ts", [
        'export const a = (s: { appendLeft(i: number, t: string): void }) => s.appendLeft(0, "x");',
        'export const b = (s: { prependRight(i: number, t: string): void }) => s.prependRight(0, "x");',
        'export const c = (s: { append(t: string): void }) => s.append("x");',
        'export const d = (s: { appendRight(i: number, t: string): void }) => s["appendRight"](0, "x");',
        "export const e = (s: { prependLeft(i: number, t: string): void }) => s[`prependLeft`](0, 'x');",
      ]),
    ).toEqual([
      [1, "insert"],
      [2, "insert"],
      [4, "insert"],
      [5, "insert"],
    ]);
  });

  it("src/build/ast.ts では報告しない", () => {
    expect(
      reports("src/build/ast.ts", [
        'export const a = (s: { appendLeft(i: number, t: string): void }) => s.appendLeft(0, "x");',
      ]),
    ).toEqual([]);
  });
});

describe("入口の指定子", () => {
  it("src/build/ の中で、rinka/ で始まる文字列を記述すると報告する", () => {
    expect(
      reports("src/build/entry.ts", [
        'export const a = "rinka/internal";',
        "export const b = (x: string) => `rinka/${x}`;",
        'export const c = "rinka";',
        'export const d = "\\0rinka/routes";',
        'export type E = typeof import("rinka/internal");',
      ]),
    ).toEqual([
      [1, "entry"],
      [2, "entry"],
      [4, "entry"],
    ]);
  });

  it("src/build/entries.ts では報告しない", () => {
    expect(reports("src/build/entries.ts", ['export const a = "rinka/internal";'])).toEqual([]);
  });
});

describe("src/ のディレクトリ", () => {
  it("src/ の直下には、shared、client、server、build のディレクトリだけを配置する", () => {
    const entries = readdirSync(join(root, "src"), { withFileTypes: true });
    const allowed = new Set(["shared", "client", "server", "build"]);
    expect(
      entries
        .filter((entry) => !entry.isDirectory() || !allowed.has(entry.name))
        .map((entry) => entry.name),
    ).toEqual([]);
  });
});

describe("後送りの境界の終わりの目印と、rinka の URL の接頭辞", () => {
  it("src/ の中の、/ob: か /_rinka/ を含む文字列のリテラルとテンプレートリテラルを報告する", () => {
    expect(
      reports("src/server/reserved-use.ts", [
        "export const a = (id: string) => `<!--/ob:${id}-->`;",
        `export const b = "/_rinka/*";`,
        `export const c = "/rinka/ob";`,
      ]),
    ).toEqual([
      [1, "reserved-path"],
      [2, "reserved-path"],
    ]);
  });

  it("src/shared/attributes.ts と src/shared/wire.ts の定義は報告しない", () => {
    expect(reports("src/shared/attributes.ts", [`export const a = "/ob:";`])).toEqual([]);
    expect(reports("src/shared/wire.ts", [`export const a = "/_rinka/";`])).toEqual([]);
  });
});

describe("ビルドの出力先", () => {
  it("src/build/ の中で、join と resolve に client か server で始まる文字列を渡すと報告する", () => {
    expect(
      reports("src/build/app-build.ts", [
        'import { join, resolve } from "node:path";',
        'export const a = (out: string) => join(out, "client");',
        'export const b = (out: string) => resolve(out, "server/entry.js");',
        "export const c = (out: string) => join(out, `client/${out}`);",
        'export const d = (out: string) => join(out, "clients");',
        'export const e = (out: string) => join(out, ".vite");',
        'export const f = "client";',
        'export const g = Promise.resolve("server");',
        'export const h = ["a"].join("client");',
      ]),
    ).toEqual([
      [2, "output-dir"],
      [3, "output-dir"],
      [4, "output-dir"],
    ]);
  });

  it("src/build/settings.ts では報告しない", () => {
    expect(
      reports("src/build/settings.ts", [
        'import { join } from "node:path";',
        'export const a = (out: string) => join(out, "client");',
      ]),
    ).toEqual([]);
  });
});

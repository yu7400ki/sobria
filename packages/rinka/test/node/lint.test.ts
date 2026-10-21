import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
copyFileSync(join(root, "oxlint.config.ts"), join(workspace, "oxlint.config.ts"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** oxlint の報告の code を、期待値で使用する短い名前に対応付ける。 */
const rules = new Map([
  ["eslint(no-restricted-imports)", "import"],
  ["eslint(no-undef)", "global"],
  ["unicorn(prefer-node-protocol)", "node"],
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
  it("src/shared/ は、client と server、rinka、Node.js の組み込みモジュール、実行環境に固有のグローバル、props の名前の一覧を参照できない", () => {
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
    ]);
  });

  it("src/client/ は、server、rinka、Node.js の組み込みモジュール、props の名前の一覧を参照できず、ブラウザのグローバルを参照できる", () => {
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
      ]),
    ).toEqual([
      [1, "import"],
      [2, "import"],
      [3, "import"],
      [4, "import"],
      [5, "node"],
      [6, "import"],
      [7, "global"],
    ]);
  });

  it("src/server/ は、client、rinka、ブラウザのグローバルを参照できず、Node.js の組み込みモジュールを参照できる", () => {
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
      ]),
    ).toEqual([
      [1, "import"],
      [2, "import"],
      [3, "import"],
      [4, "global"],
      [5, "global"],
    ]);
  });
});

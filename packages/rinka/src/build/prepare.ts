import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { scanElements } from "./elements.ts";
import { entries } from "./entries.ts";
import { inside } from "./paths.ts";
import { ROUTES_DIR, scanPages } from "./routes.ts";

/** 生成したファイルを置く、アプリのルートからの相対パスのディレクトリである。 */
export const PREPARED_DIR = ".rinka";

/** `.rinka/` に tsconfig を生成するプロジェクトの名前である。 */
export const PROJECTS = ["shared", "elements", "server"] as const;

/** `.rinka/` に tsconfig を生成するプロジェクトの名前を表す。 */
type Project = (typeof PROJECTS)[number];

/** プロジェクト `project` の tsconfig の、`.rinka/` の中のファイルの名前を返す。 */
export const projectConfig = (project: Project): string => `tsconfig.${project}.json`;

/** 生成する tsconfig が extends する、アプリの tsconfig のファイルの名前である。 */
const BASE_CONFIG = "tsconfig.base.json";

/** パス `path` が、アプリのルート `root` のルートのディレクトリの中か、要素のディレクトリ `elementsDir` の中か、`tsconfig.base.json` なら真を返す。 */
export const isPrepareInput = (root: string, elementsDir: string, path: string): boolean =>
  inside(join(root, ROUTES_DIR), path) !== undefined ||
  inside(elementsDir, path) !== undefined ||
  resolve(path) === join(root, BASE_CONFIG);

/** `.rinka/` のファイルを生成する入力を表す。 */
export interface PrepareOptions {
  /** アプリのルートの絶対パスである。 */
  readonly root: string;
  /** 要素のタグ名の接頭辞である。 */
  readonly prefix: string;
  /** 要素のディレクトリの絶対パスである。 */
  readonly elementsDir: string;
  /** 真なら、`env.d.ts` でグローバルの `JSX.Element` を宣言する。 */
  readonly globalJSX: boolean;
}

/** 生成したファイルの先頭に付けるコメントである。 */
const HEADER = "// rinka prepare が生成したファイルである。\n";

/** アプリのファイルを走査し、`.rinka/` に置くファイルの名前ごとの内容を返す。生成する tsconfig は、アプリに `tsconfig.base.json` があればそれも extends する。 */
export function preparedFiles(options: PrepareOptions): Map<string, string> {
  const { root, elementsDir } = options;
  const prepared = join(root, PREPARED_DIR);
  const fromPrepared = (path: string): string => relative(prepared, path).split(sep).join("/");
  const base = existsSync(join(root, BASE_CONFIG)) ? [`../${BASE_CONFIG}`] : [];
  const routesDir = fromPrepared(join(root, ROUTES_DIR));
  const elements = fromPrepared(elementsDir);
  const tsconfig = (
    project: Project,
    customConditions: readonly string[],
    files: { include: readonly string[]; exclude?: readonly string[] },
    references: readonly Project[],
  ): string =>
    `${JSON.stringify(
      {
        extends: [entries.tsconfig, ...base],
        compilerOptions: { rootDir: "..", outDir: `out/${project}`, customConditions },
        ...files,
        ...(references.length > 0 && {
          references: references.map((name) => ({ path: projectConfig(name) })),
        }),
      },
      null,
      2,
    )}\n`;
  return new Map([
    ["routes.d.ts", routesDeclaration(root)],
    ["env.d.ts", envDeclaration(options.globalJSX)],
    ["elements.d.ts", elementsDeclaration(options.prefix, elementsDir, fromPrepared)],
    [
      projectConfig("shared"),
      tsconfig(
        "shared",
        ["rinka-shared", "rinka-server"],
        { include: [fromPrepared(join(root, "src")), "env.d.ts"], exclude: [elements, routesDir] },
        [],
      ),
    ],
    [
      projectConfig("elements"),
      tsconfig(
        "elements",
        ["rinka-client"],
        { include: [elements, "env.d.ts", "elements.d.ts", "routes.d.ts"] },
        ["shared"],
      ),
    ],
    [
      projectConfig("server"),
      tsconfig("server", ["rinka-server"], { include: [routesDir, "env.d.ts", "routes.d.ts"] }, [
        "elements",
        "shared",
      ]),
    ],
  ]);
}

/** アプリのルート `root` のページから、`RouteParams` を拡張する型宣言を返す。 */
function routesDeclaration(root: string): string {
  const lines: string[] = [];
  for (const { path, params } of scanPages(root, ROUTES_DIR)) {
    const type =
      params.length === 0 ? "{}" : `{ ${params.map((name) => `${name}: string`).join("; ")} }`;
    lines.push(`    ${JSON.stringify(path)}: ${type};\n`);
  }
  return `${HEADER}export {};\n\ndeclare module "${entries.router}" {\n  interface RouteParams {\n${lines.toSorted().join("")}  }\n}\n`;
}

/** `*.css` の型と、`globalJSX` が真ならグローバルの `JSX.Element` を宣言する、モジュールではない型宣言を返す。 */
function envDeclaration(globalJSX: boolean): string {
  const css = `declare module "*.css" {\n  const sheet: CSSStyleSheet;\n  export default sheet;\n}\n`;
  const jsx = `\ndeclare namespace JSX {\n  type Element = import("${entries.main}").Slot;\n}\n`;
  return `${HEADER}${css}${globalJSX ? jsx : ""}`;
}

/** 要素のディレクトリ `dir` の要素のタグを、`HTMLElementTagNameMap` に追加する型宣言を返す。 */
function elementsDeclaration(
  prefix: string,
  dir: string,
  fromPrepared: (path: string) => string,
): string {
  const elements = scanElements([{ prefix, elementsDir: dir }]);
  const imports = elements.map(
    ({ path }, index) => `import type E${index} from ${JSON.stringify(fromPrepared(path))};\n`,
  );
  const tags = elements.map(
    ({ tag }, index) => `    ${JSON.stringify(tag)}: ElementRef<typeof E${index}>;\n`,
  );
  return `${HEADER}import type { ElementRef } from "${entries.main}";\n${imports.join("")}\ndeclare global {\n  interface HTMLElementTagNameMap {\n${tags.join("")}  }\n}\n`;
}

/** アプリのルート `root` の `.rinka/` に `files` を書き込み、内容が変わって書き込んだファイルの名前を返す。 */
export function writePrepared(root: string, files: ReadonlyMap<string, string>): string[] {
  const dir = join(root, PREPARED_DIR);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of files) {
    const path = join(dir, name);
    if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
    writeFileSync(path, content);
    written.push(name);
  }
  return written;
}

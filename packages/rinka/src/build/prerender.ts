import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ESTree } from "vite";

import { prerenderEnv, type PrerenderScope, type PrerenderTarget } from "../shared/prerender.ts";
import { moduleExportName, parseModule, sourceLangOf } from "./ast.ts";
import { entries, importInternal } from "./entries.ts";
import { inside } from "./paths.ts";
import { scanRoutes } from "./routes.ts";
import { SERVER_ENTRY_NAME } from "./settings.ts";

/** サーバーのビルドで、書き出す URL を返すモジュールの入力の名前である。出力のファイルの名前は、この名前に `.js` を付けたものになる。 */
export const PRERENDER_ENTRY_NAME = "prerender";

/** `program` が、名前 `name` を export するかどうかを返す。`export *` は調べない。 */
function exportsName(program: ESTree.Program, name: string): boolean {
  return program.body.some((statement) => {
    if (statement.type !== "ExportNamedDeclaration") return false;
    const { declaration, specifiers } = statement;
    if (declaration?.type === "VariableDeclaration") {
      return declaration.declarations.some(
        (declarator) => declarator.id.type === "Identifier" && declarator.id.name === name,
      );
    }
    if (declaration?.type === "FunctionDeclaration") return declaration.id?.name === name;
    return specifiers.some((specifier) => moduleExportName(specifier.exported) === name);
  });
}

/**
 * プロジェクトのルート `root` のページと `route.ts` のうち、`prerender` を export するもののファイルを返す。
 * 登録した拡張子 `extensions` のページは、`prerender` を export するかにかかわらず返す。
 */
export function prerenderFiles(root: string, extensions: readonly string[]): string[] {
  const files: string[] = [];
  for (const route of scanRoutes(root, extensions).routes) {
    if (route.kind === "not-found") continue;
    const path = join(root, route.module);
    const source = sourceLangOf(path, extensions);
    if (!source)
      throw new Error(`[rinka] ${route.module} は、変換できない拡張子のルートのファイルです。`);
    if (source.registered) {
      files.push(route.module);
      continue;
    }
    const code = readFileSync(path, "utf8");
    if (!code.includes("prerender")) continue;
    const program = parseModule(code, { id: path, file: route.module, lang: source.lang });
    if (exportsName(program, "prerender")) files.push(route.module);
  }
  return files;
}

/** 範囲 `scope` の書き出す URL を返す関数を、default で export するモジュールのコードを返す。 */
export const prerenderModule = (scope: PrerenderScope): string =>
  [
    importInternal("server", "prerenderTargets"),
    `import * as routes from "${entries.routes}";`,
    "",
    `export default () => prerenderTargets(routes, ${JSON.stringify(scope)});`,
    "",
  ].join("\n");

/** URL のパス `pathname` のレスポンスを保存するファイルの、`clientDir` からのパスを返す。ページは `index.html` に保存する。`clientDir` の外を指すときは、エラーを投げる。 */
function fileOf(clientDir: string, pathname: string, kind: "page" | "route"): string {
  const parts = pathname
    .split("/")
    .filter((part) => part !== "")
    .map(decodeURIComponent);
  const file = resolve(clientDir, ...parts, ...(kind === "page" ? ["index.html"] : []));
  if (
    parts.some((part) => part === "." || part === ".." || /[/\\]/.test(part)) ||
    inside(resolve(clientDir), file) === undefined
  ) {
    throw new Error(`[rinka] ${pathname} は、書き出しの出力先の外を指します。`);
  }
  return file;
}

/** 書き出しの対象の種類ごとの、期待するステータスである。 */
const expectedStatus = { page: 200, route: 200, "not-found": 404 } as const;

/**
 * サーバーの出力先 `serverDir` の書き出すモジュールを読み込み、書き出す URL があれば、サーバーのエントリーを読み込んで、各 URL に `base` を前置して要求し、レスポンスの本文をクライアントの出力先 `clientDir` に保存する。
 * 保存先のパスには `base` を含めない。
 * ページは `<パス>/index.html` に、`route.ts` は URL のパスのとおりに、`404.html` の対象は `404.html` に保存する。
 * 対象の種類ごとに期待するステータスと異なるレスポンスと、既にあるファイルと重なる保存先は、エラーにする。
 */
export async function writePrerendered(
  serverDir: string,
  clientDir: string,
  base: string,
): Promise<void> {
  const load = async (name: string): Promise<unknown> =>
    import(pathToFileURL(join(serverDir, `${name}.js`)).href);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const prerender = (await load(PRERENDER_ENTRY_NAME)) as {
    readonly default: () => Promise<readonly PrerenderTarget[]>;
  };
  const targets = await prerender.default();
  if (targets.every((target) => target.urls.length === 0)) return;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const entry = (await load(SERVER_ENTRY_NAME)) as {
    readonly default: {
      readonly fetch: (request: Request, env: object) => Response | Promise<Response>;
    };
  };
  for (const target of targets) {
    for (const url of target.urls) {
      // 書き出しの順序とエラーを決定的にするため、URL を 1 つずつ取得する
      // oxlint-disable-next-line no-await-in-loop
      const response = await entry.default.fetch(
        new Request(new URL(base + url.slice(1), "http://localhost")),
        {
          [prerenderEnv]: target.kind,
        },
      );
      const expected = expectedStatus[target.kind];
      const source = target.kind === "not-found" ? "404.html" : target.file;
      if (response.status !== expected) {
        throw new Error(
          `[rinka] ${url} を書き出すと、ステータスが ${response.status} になりました。${source} の書き出しのレスポンスは、${expected} である必要があります。`,
        );
      }
      const file =
        target.kind === "not-found"
          ? join(clientDir, "404.html")
          : fileOf(clientDir, new URL(url, "http://localhost").pathname, target.kind);
      if (existsSync(file)) {
        throw new Error(`[rinka] ${url} を書き出すファイル ${file} は、既にあります。`);
      }
      mkdirSync(dirname(file), { recursive: true });
      // oxlint-disable-next-line no-await-in-loop
      writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
    }
  }
}

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { ESTree } from "vite";

import { prerenderEnv, type PrerenderKind } from "../shared/prerender.ts";
import { langs, moduleExportName, parseModule } from "./ast.ts";
import { entries, importInternal } from "./entries.ts";
import { ROUTES_DIR, scanRoutes } from "./routes.ts";
import { SERVER_ENTRY_NAME } from "./settings.ts";

/** サーバーのビルドで、書き出す URL を返すモジュールの入力の名前である。出力のファイルの名前は、この名前に `.js` を付けたものになる。 */
export const PRERENDER_ENTRY_NAME = "prerender";

/** `404.html` に保存する 404 のページを取得する URL のパスである。 */
const MISSING_PATH = "/__rinka/not-found";

/** 書き出すルートの範囲を表す。ページと `route.ts` のファイルの集合か、すべてのルートを表す `"all"` である。 */
export type PrerenderScope = ReadonlySet<string> | "all";

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

/** プロジェクトのルート `root` のページと `route.ts` のうち、`prerender` を export するもののファイルを返す。 */
export function prerenderFiles(root: string): Set<string> {
  const files = new Set<string>();
  for (const route of scanRoutes(root, ROUTES_DIR).routes) {
    if (route.kind === "not-found") continue;
    const path = join(root, route.module);
    const code = readFileSync(path, "utf8");
    if (!code.includes("prerender")) continue;
    const program = parseModule(code, {
      id: path,
      file: route.module,
      lang: langs[extname(path)]!,
    });
    if (exportsName(program, "prerender")) files.add(route.module);
  }
  return files;
}

/** 範囲 `scope` の書き出す URL を返す関数を、default で export するモジュールのコードを返す。 */
export const prerenderModule = (scope: PrerenderScope): string =>
  [
    importInternal("server", "prerenderTargets"),
    `import * as routes from "${entries.routes}";`,
    "",
    `export default () => prerenderTargets(routes, ${scope === "all" ? '"all"' : `new Set(${JSON.stringify([...scope])})`});`,
    "",
  ].join("\n");

/** `prerenderModule` のモジュールが返す、書き出す URL を表す。 */
interface Target {
  readonly kind: "page" | "route";
  readonly urls: readonly string[];
}

/** URL のパス `pathname` のレスポンスを保存するファイルの、`clientDir` からのパスを返す。ページは `index.html` に保存する。`clientDir` の外を指すときは、エラーを投げる。 */
function fileOf(clientDir: string, pathname: string, kind: Target["kind"]): string {
  const parts = pathname
    .split("/")
    .filter((part) => part !== "")
    .map(decodeURIComponent);
  const file = resolve(clientDir, ...parts, ...(kind === "page" ? ["index.html"] : []));
  const inside = relative(resolve(clientDir), file);
  if (
    parts.some((part) => part === "." || part === ".." || /[/\\]/.test(part)) ||
    isAbsolute(inside) ||
    inside === ".." ||
    inside.startsWith(`..${sep}`)
  ) {
    throw new Error(`[rinka] ${pathname} は、書き出しの出力先の外を指します。`);
  }
  return file;
}

/**
 * サーバーの出力先 `serverDir` のサーバーのエントリーと書き出すモジュールを読み込み、書き出す各 URL のレスポンスの本文を、クライアントの出力先 `clientDir` に保存する。
 * 保存した後で、書き出すモジュールを削除する。200 以外のレスポンスと、既にあるファイルと重なる URL は、エラーにする。
 * `alone` が真なら、存在しない URL のレスポンスが 404 のときに、その本文を `404.html` に保存し、最後に `serverDir` を削除する。
 */
export async function writePrerendered(
  serverDir: string,
  clientDir: string,
  alone: boolean,
): Promise<void> {
  const load = async (name: string): Promise<unknown> =>
    import(pathToFileURL(join(serverDir, `${name}.js`)).href);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const entry = (await load(SERVER_ENTRY_NAME)) as {
    readonly default: {
      readonly fetch: (request: Request, env: object) => Response | Promise<Response>;
    };
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const targets = (await load(PRERENDER_ENTRY_NAME)) as {
    readonly default: () => Promise<readonly Target[]>;
  };
  /** URL のパス `url` を、書き出しのリクエストとしてサーバーのエントリーで描画する。 */
  const render = async (url: string, kind: PrerenderKind = "page") =>
    entry.default.fetch(new Request(new URL(url, "http://localhost")), { [prerenderEnv]: kind });
  for (const { kind, urls } of await targets.default()) {
    for (const url of urls) {
      // 書き出しの順序とエラーを決定的にするため、URL を 1 つずつ取得する
      // oxlint-disable-next-line no-await-in-loop
      const response = await render(url);
      if (response.status !== 200) {
        throw new Error(
          `[rinka] ${url} を書き出すと、ステータスが ${response.status} になりました。書き出す URL は、200 のレスポンスを返す必要があります。`,
        );
      }
      const file = fileOf(clientDir, new URL(url, "http://localhost").pathname, kind);
      if (existsSync(file)) {
        throw new Error(`[rinka] ${url} を書き出すファイル ${file} は、既にあります。`);
      }
      mkdirSync(dirname(file), { recursive: true });
      // oxlint-disable-next-line no-await-in-loop
      writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
    }
  }
  if (alone) {
    const missing = await render(MISSING_PATH, "not-found");
    const file = join(clientDir, "404.html");
    if (missing.status === 404 && !existsSync(file)) {
      writeFileSync(file, new Uint8Array(await missing.arrayBuffer()));
    }
    rmSync(serverDir, { recursive: true, force: true });
    return;
  }
  for (const suffix of [".js", ".js.map"]) {
    rmSync(join(serverDir, `${PRERENDER_ENTRY_NAME}${suffix}`), { force: true });
  }
}

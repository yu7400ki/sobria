import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { parseSegment } from "../shared/route-segments.ts";
import {
  mapRouteFiles,
  type Fallback,
  type Route,
  type RouteFiles,
  type RouteKind,
  type Routes,
} from "../shared/routes.ts";

/** 走査したルートの表で、各ファイルを、プロジェクトのルートからの `/` で区切った相対パスで表す型である。 */
export interface PathFiles extends RouteFiles {
  readonly component: string;
  readonly middleware: string;
  readonly handlers: string;
}

/** 走査したルートの表の 1 行を表す。 */
type ScannedRoute = Route<PathFiles>;

/** ページと `not-found.tsx` の行に付ける、エラーのページを表す。 */
interface Fallbacks {
  readonly notFound?: Fallback<PathFiles>;
  readonly error?: Fallback<PathFiles>;
}

/** ディレクトリにあれば表の行になるファイルの名前と、その種類である。 */
const routeFiles: readonly (readonly [string, RouteKind])[] = [
  ["page.tsx", "page"],
  ["route.ts", "route"],
  ["not-found.tsx", "not-found"],
];

/** ルートの表に関わるファイルの名前である。 */
export const routeFileNames: ReadonlySet<string> = new Set([
  ...routeFiles.map(([name]) => name),
  "layout.tsx",
  "middleware.ts",
  "error.tsx",
]);

/**
 * ディレクトリの名前を、Hono のパスの区切りにする。グループは `undefined` にする。
 * `[` か `(` で始まり、動的な区切り、キャッチオール、グループのどれの形でもない名前は、`file` を示すエラーにする。
 */
function segmentOf(name: string, file: string): string | undefined {
  const segment = parseSegment(name);
  switch (segment?.kind) {
    case "static":
      return segment.name;
    case "param":
      return `:${segment.name}`;
    case "catch-all":
      return `:${segment.name}{.+}`;
    case "group":
      return undefined;
    case undefined:
      throw new Error(
        `${file} の名前は、動的な区切り（[id]）、キャッチオール（[...slug]）、グループ（(name)）のどれの形でもありません。パラメータの名前には、ASCII の英数字と _ を使用してください。`,
      );
  }
}

/** キャッチオールの区切りかどうかを返す。 */
const isCatchAll = (segment: string): boolean => segment.endsWith("{.+}");

/** 区切りの優先順位を返す。静的な区切り、動的な区切り、キャッチオールの順に小さい。 */
const rankOf = (segment: string): number =>
  segment.startsWith(":") ? (isCatchAll(segment) ? 2 : 1) : 0;

/** パラメータの名前を除いた、パスが一致する URL の形を返す。 */
const shapeOf = (path: string): string =>
  path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? (isCatchAll(segment) ? "*" : ":") : segment))
    .join("/");

/**
 * `not-found.tsx` の行を、ページと `route.ts` の行の後に、区切りの数が多い順に並べる。
 * ページと `route.ts` の行どうしと、区切りの数が同じ `not-found.tsx` の行どうしは、区切りの優先順位を前から比較し、一方が他方の前方と一致するなら短いほうを先にする。
 * 優先順位が同じなら、パスの文字列の順にし、同じパスならファイルのディレクトリが浅いほうを先にする。
 */
function compareRoutes(a: ScannedRoute, b: ScannedRoute): number {
  const isNotFound = a.kind === "not-found";
  if (isNotFound !== (b.kind === "not-found")) return isNotFound ? 1 : -1;
  const left = a.path.split("/");
  const right = b.path.split("/");
  if (isNotFound && left.length !== right.length) return right.length - left.length;
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = rankOf(left[index] ?? "") - rankOf(right[index] ?? "");
    if (difference !== 0) return difference;
  }
  if (left.length !== right.length) return left.length - right.length;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.module.split("/").length - b.module.split("/").length;
}

/** 種類が `kind` の行を返す。ページには `fallbacks` を、`not-found.tsx` には `fallbacks` の `error` を付ける。 */
function rowOf(
  kind: RouteKind,
  path: string,
  module: string,
  layouts: readonly string[],
  middlewares: readonly string[],
  fallbacks: Fallbacks,
): ScannedRoute {
  switch (kind) {
    case "page":
      return { kind, path, module, layouts, middlewares, ...fallbacks };
    case "not-found":
      return {
        kind,
        path,
        module,
        layouts,
        middlewares,
        ...(fallbacks.error && { error: fallbacks.error }),
      };
    case "route":
      return { kind, path, module, middlewares };
  }
}

/**
 * プロジェクトのルート `root` からの相対パス `dir` のディレクトリを走査し、ルートの表を返す。
 * ルートは、同じ位置では静的な区切り、動的な区切り、キャッチオールの順に並ぶ。
 * 2 つの `page.tsx` か `route.ts` が同じ URL に対応するときは、エラーを投げる。同じディレクトリに `page.tsx` と `route.ts` を置いたときも、このエラーになる。
 * キャッチオールのディレクトリの配下のディレクトリにルートのファイルがあるときも、エラーを投げる。
 */
export function scanRoutes(root: string, dir: string): Routes<PathFiles> {
  const routes: ScannedRoute[] = [];
  let middleware: string | undefined;
  const start = resolve(root, dir);
  const fileOf = (path: string): string => relative(root, path).split(sep).join("/");
  const visit = (
    current: string,
    segments: readonly string[],
    outerLayouts: readonly string[],
    outerMiddlewares: readonly string[],
    outerFallbacks: Fallbacks,
  ): void => {
    const entries = readdirSync(current, { withFileTypes: true }).toSorted((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const layouts = files.has("layout.tsx")
      ? [...outerLayouts, fileOf(join(current, "layout.tsx"))]
      : outerLayouts;
    let middlewares = outerMiddlewares;
    if (files.has("middleware.ts")) {
      const file = fileOf(join(current, "middleware.ts"));
      if (current === start) middleware = file;
      else middlewares = [...outerMiddlewares, file];
    }
    const fallbackOf = (name: string): Fallback<PathFiles> | undefined =>
      files.has(name) ? { module: fileOf(join(current, name)), layouts } : undefined;
    const notFound = fallbackOf("not-found.tsx") ?? outerFallbacks.notFound;
    const error = fallbackOf("error.tsx") ?? outerFallbacks.error;
    const fallbacks: Fallbacks = {
      ...(notFound !== undefined && { notFound }),
      ...(error !== undefined && { error }),
    };
    for (const [name, kind] of routeFiles) {
      if (!files.has(name)) continue;
      const file = fileOf(join(current, name));
      if (segments.slice(0, -1).some(isCatchAll)) {
        throw new Error(
          `${file} は、キャッチオールのディレクトリの配下にあります。キャッチオールの配下には、ルートのファイルを置けません。`,
        );
      }
      const path = `/${(kind === "not-found" ? [...segments, "*"] : segments).join("/")}`;
      routes.push(rowOf(kind, path, file, layouts, middlewares, fallbacks));
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const segment = segmentOf(entry.name, fileOf(join(current, entry.name)));
      visit(
        join(current, entry.name),
        segment === undefined ? segments : [...segments, segment],
        layouts,
        middlewares,
        fallbacks,
      );
    }
  };
  if (existsSync(start)) visit(start, [], [], [], {});

  const handled = new Map<string, ScannedRoute>();
  for (const route of routes) {
    if (route.kind === "not-found") continue;
    const shape = shapeOf(route.path);
    const other = handled.get(shape);
    if (other) {
      throw new Error(
        `${other.module} と ${route.module} は、同じ URL に対応します。どちらか一方にしてください。`,
      );
    }
    handled.set(shape, route);
  }
  return {
    routes: routes.toSorted(compareRoutes),
    ...(middleware !== undefined && { middleware }),
  };
}

/** 生成するコードで、モジュールを読み込む関数に置き換える文字列の接頭辞である。 */
const importMarker = "\0import:";

/** `importMarker` を付けた文字列の JSON を、モジュールを読み込む関数のコードに置き換える正規表現である。 */
const importPattern = /"\\u0000import:((?:[^"\\]|\\.)*)"/g;

/** `value` を JavaScript の式にする。`importMarker` を付けた文字列は、モジュールを読み込む関数にする。 */
const toCode = (value: unknown): string =>
  JSON.stringify(value).replaceAll(importPattern, '() => import("$1")');

/** ファイル `file` を、モジュールを読み込む関数に置き換える目印の文字列にする。 */
const toImport = (file: string): string => `${importMarker}/${file}`;

/** `root` からの相対パス `dir` を走査し、ファイルごとにモジュールを読み込む関数を持つルートの表を export するモジュールのコードを返す。 */
export function routesModule(root: string, dir: string): string {
  const { routes, middleware } = mapRouteFiles<PathFiles, PathFiles>(scanRoutes(root, dir), {
    component: toImport,
    middleware: toImport,
    handlers: toImport,
  });
  return [
    `export const routes = ${toCode(routes)};`,
    ...(middleware === undefined ? [] : [`export const middleware = ${toCode(middleware)};`]),
    "",
  ].join("\n");
}

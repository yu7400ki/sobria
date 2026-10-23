import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { parseSegment, type RouteSegment } from "../shared/route-segments.ts";
import {
  mapRouteFiles,
  type Fallback,
  type Fallbacks,
  type Route,
  type Files,
  type RouteKind,
  type Routes,
} from "../shared/routes.ts";

/** 走査したルートの表で、各ファイルを、プロジェクトのルートからの `/` で区切った相対パスで表す型である。 */
export type PathFiles = Files<string, string, string>;

/** 走査したルートの表の 1 行を表す。 */
type ScannedRoute = Route<PathFiles>;

/** ルートのファイルを置く、アプリのルートからの相対パスのディレクトリである。 */
export const ROUTES_DIR = "src/routes";

/** ページのファイルの名前である。 */
export const PAGE_FILE = "page.tsx";

/** ディレクトリにあれば表の行になるファイルの名前と、その種類である。 */
const routeFiles: readonly (readonly [string, RouteKind])[] = [
  [PAGE_FILE, "page"],
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

/** ディレクトリの名前を区切りにする。`[` か `(` で始まり、動的な区切り、キャッチオール、グループのどれの形でもない名前は、`file` を示すエラーにする。 */
function segmentOf(name: string, file: string): RouteSegment {
  const segment = parseSegment(name);
  if (segment === undefined) {
    throw new Error(
      `${file} の名前は、動的な区切り（[id]）、キャッチオール（[...slug]）、グループ（(name)）のどれの形でもありません。パラメータの名前には、ASCII の英数字と _ を使用してください。`,
    );
  }
  return segment;
}

/** URL の区切りになる、グループ以外の区切りを表す。 */
type UrlSegment = Exclude<RouteSegment, { readonly kind: "group" }>;

/** 区切りの種類ごとの優先順位である。 */
const ranks = { static: 0, param: 1, "catch-all": 2 } as const satisfies Record<
  UrlSegment["kind"],
  number
>;

/** 区切りの列から Hono のパスを組み立てる。`not-found.tsx` の行は、配下のすべての URL に一致するパスにする。 */
function honoPath(segments: readonly UrlSegment[], kind: RouteKind): string {
  const parts = segments.map((segment) => {
    switch (segment.kind) {
      case "static":
        return segment.name;
      case "param":
        return `:${segment.name}`;
      case "catch-all":
        return `:${segment.name}{.+}`;
    }
  });
  return `/${(kind === "not-found" ? [...parts, "*"] : parts).join("/")}`;
}

/** パラメータの名前を除いた、区切りの列が一致する URL の形を返す。動的な区切りとキャッチオールは、静的な区切りの名前と重ならない `[` で始まる記号で表す。 */
const shapeOf = (segments: readonly UrlSegment[]): string =>
  segments
    .map((segment) => (segment.kind === "static" ? segment.name : `[${segment.kind}]`))
    .join("/");

/** 区切りの列から、グループを除いたファイルの形のパス（`/users/[id]`、`/docs/[...slug]`）を組み立てる。 */
const filePath = (segments: readonly UrlSegment[]): string =>
  `/${segments
    .map((segment) => {
      switch (segment.kind) {
        case "static":
          return segment.name;
        case "param":
          return `[${segment.name}]`;
        case "catch-all":
          return `[...${segment.name}]`;
      }
    })
    .join("/")}`;

/** `left` と `right` の同じ位置の要素を、短いほうの長さまで組にする。 */
function zip<T extends object>(left: readonly T[], right: readonly T[]): (readonly [T, T])[] {
  return left.flatMap((item, index) => {
    const other = right[index];
    return other === undefined ? [] : [[item, other] as const];
  });
}

/** 走査した行と、その区切りの列と、グループを含めたファイルのディレクトリの深さを表す。 */
interface Scanned {
  readonly route: ScannedRoute;
  readonly segments: readonly UrlSegment[];
  readonly depth: number;
}

/**
 * `not-found.tsx` の行を、ページと `route.ts` の行の後に、区切りの数が多い順に並べる。
 * ページと `route.ts` の行どうしと、区切りの数が同じ `not-found.tsx` の行どうしは、区切りの優先順位を前から比較し、一方が他方の前方と一致するなら短いほうを先にする。
 * 優先順位が同じなら、静的な区切りの名前を前から比較し、名前も同じならファイルのディレクトリが浅いほうを先にする。
 */
function compareRoutes(a: Scanned, b: Scanned): number {
  const isNotFound = a.route.kind === "not-found";
  if (isNotFound !== (b.route.kind === "not-found")) return isNotFound ? 1 : -1;
  if (isNotFound && a.segments.length !== b.segments.length) {
    return b.segments.length - a.segments.length;
  }
  const pairs = zip(a.segments, b.segments);
  for (const [left, right] of pairs) {
    const difference = ranks[left.kind] - ranks[right.kind];
    if (difference !== 0) return difference;
  }
  if (a.segments.length !== b.segments.length) return a.segments.length - b.segments.length;
  for (const [left, right] of pairs) {
    if (left.kind === "static" && left.name !== right.name) return left.name < right.name ? -1 : 1;
  }
  return a.depth - b.depth;
}

/** 種類が `kind` の行を返す。ページと `not-found.tsx` には `fallbacks` を付け、`not-found.tsx` の `notFound` はその行のファイルにする。 */
function rowOf({
  kind,
  path,
  module,
  layouts,
  middlewares,
  fallbacks,
}: {
  readonly kind: RouteKind;
  readonly path: string;
  readonly module: string;
  readonly layouts: readonly string[];
  readonly middlewares: readonly string[];
  readonly fallbacks: Fallbacks<PathFiles>;
}): ScannedRoute {
  switch (kind) {
    case "page":
      return { kind, path, module, layouts, middlewares, ...fallbacks };
    case "not-found":
      return { kind, path, middlewares, ...fallbacks, notFound: { module, layouts } };
    case "route":
      return { kind, path, module, middlewares };
  }
}

/**
 * プロジェクトのルート `root` からの相対パス `dir` のディレクトリを走査し、走査した行の列と、ルートのミドルウェアを返す。
 * 2 つの `page.tsx` か `route.ts` が同じ URL に対応するときは、エラーを投げる。同じディレクトリに `page.tsx` と `route.ts` を置いたときも、このエラーになる。
 * 同じ URL に対応し、グループを含めたディレクトリの深さが同じ 2 つの `not-found.tsx` があるときも、エラーを投げる。
 * キャッチオールのディレクトリの配下のディレクトリにルートのファイルがあるときも、エラーを投げる。
 */
function scan(
  root: string,
  dir: string,
): { readonly scanned: readonly Scanned[]; readonly middleware: string | undefined } {
  const scanned: Scanned[] = [];
  let middleware: string | undefined;
  const start = resolve(root, dir);
  const fileOf = (path: string): string => relative(root, path).split(sep).join("/");
  const visit = (
    current: string,
    segments: readonly UrlSegment[],
    depth: number,
    outerLayouts: readonly string[],
    outerMiddlewares: readonly string[],
    outerFallbacks: Fallbacks<PathFiles>,
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
    const fallbacks: Fallbacks<PathFiles> = {
      ...(notFound !== undefined && { notFound }),
      ...(error !== undefined && { error }),
    };
    for (const [name, kind] of routeFiles) {
      if (!files.has(name)) continue;
      const file = fileOf(join(current, name));
      if (segments.slice(0, -1).some((segment) => segment.kind === "catch-all")) {
        throw new Error(
          `${file} は、キャッチオールのディレクトリの配下にあります。キャッチオールの配下には、ルートのファイルを置けません。`,
        );
      }
      const path = honoPath(segments, kind);
      const route = rowOf({ kind, path, module: file, layouts, middlewares, fallbacks });
      scanned.push({ route, segments, depth });
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const segment = segmentOf(entry.name, fileOf(join(current, entry.name)));
      visit(
        join(current, entry.name),
        segment.kind === "group" ? segments : [...segments, segment],
        depth + 1,
        layouts,
        middlewares,
        fallbacks,
      );
    }
  };
  if (existsSync(start)) visit(start, [], 0, [], [], {});

  const pages = new Map<string, string>();
  const notFounds = new Map<string, string>();
  for (const { route, segments, depth } of scanned) {
    const [handled, key, file] =
      route.kind === "not-found"
        ? [notFounds, `${depth} ${shapeOf(segments)}`, route.notFound.module]
        : [pages, shapeOf(segments), route.module];
    const other = handled.get(key);
    if (other !== undefined) {
      throw new Error(
        `${other} と ${file} は、同じ URL に対応します。どちらか一方にしてください。`,
      );
    }
    handled.set(key, file);
  }
  return { scanned, middleware };
}

/**
 * プロジェクトのルート `root` からの相対パス `dir` のディレクトリを走査し、ルートの表を返す。
 * ルートは、同じ位置では静的な区切り、動的な区切り、キャッチオールの順に並ぶ。ルートのファイルの配置が不正なら、エラーを投げる。
 */
export function scanRoutes(root: string, dir: string): Routes<PathFiles> {
  const { scanned, middleware } = scan(root, dir);
  return {
    routes: scanned.toSorted(compareRoutes).map(({ route }) => route),
    ...(middleware !== undefined && { middleware }),
  };
}

/** `root` からの相対パス `dir` のページごとに、グループを除いたファイルの形のパスと、パラメータとキャッチオールの名前を返す。ルートのファイルの配置が不正なら、エラーを投げる。 */
export function scanPages(
  root: string,
  dir: string,
): { readonly path: string; readonly params: readonly string[] }[] {
  return scan(root, dir)
    .scanned.filter(({ route }) => route.kind === "page")
    .map(({ segments }) => ({
      path: filePath(segments),
      params: segments.flatMap((segment) => (segment.kind === "static" ? [] : [segment.name])),
    }));
}

/** 生成するコードで、モジュールを読み込む関数に置き換える文字列の接頭辞である。 */
const importMarker = "\0import:";

/** `importMarker` を付けた文字列の JSON を、モジュールを読み込む関数のコードに置き換える正規表現である。 */
const importPattern = /"\\u0000import:((?:[^"\\]|\\.)*)"/g;

/** `value` を JavaScript の式にする。`importMarker` を付けた文字列は、モジュールを読み込み、`file` にファイルのパスを持つ関数にする。 */
const toCode = (value: unknown): string =>
  JSON.stringify(value).replaceAll(
    importPattern,
    'Object.assign(() => import("/$1"), { file: "$1" })',
  );

/** ファイル `file` を、モジュールを読み込む関数に置き換える目印の文字列にする。 */
const toImport = (file: string): string => `${importMarker}${file}`;

/** `root` からの相対パス `dir` を走査し、ファイルごとにモジュールを読み込む関数を持つルートの表を export するモジュールのコードを返す。 */
export function routesModule(root: string, dir: string): string {
  const { routes, middleware } = mapRouteFiles(scanRoutes(root, dir), {
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

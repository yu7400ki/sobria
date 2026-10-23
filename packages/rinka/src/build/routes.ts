import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { RouteKind } from "../shared/routes.ts";

/** エラーのページのファイルと、外側から順に列挙した、そのディレクトリのレイアウトのファイルを表す。 */
export interface ScannedFallback {
  readonly file: string;
  readonly layouts: readonly string[];
}

/** 走査したルートの 1 行を表す。ファイルは、プロジェクトのルートからの相対パスで、区切りは `/` である。 */
export interface ScannedRoute {
  readonly kind: RouteKind;
  /** Hono のパスである。 */
  readonly path: string;
  readonly file: string;
  /** 外側から順に列挙したレイアウトのファイルである。 */
  readonly layouts: readonly string[];
  /** 外側から順に列挙した、ルートのディレクトリ以外の `middleware.ts` である。 */
  readonly middlewares: readonly string[];
  /** ページと `not-found.tsx` の行の、ディレクトリの祖先で最も近い `not-found.tsx` である。 */
  readonly notFound?: ScannedFallback;
  /** ページと `not-found.tsx` の行の、ディレクトリの祖先で最も近い `error.tsx` である。 */
  readonly error?: ScannedFallback;
}

/** 走査したルートの表を表す。`middleware` は、ルートのディレクトリの `middleware.ts` である。 */
export interface ScannedRoutes {
  readonly routes: readonly ScannedRoute[];
  readonly middleware?: string;
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
  if (/^\(.+\)$/.test(name)) return undefined;
  const catchAll = /^\[\.\.\.(\w+)\]$/.exec(name);
  if (catchAll) return `:${catchAll[1]}{.+}`;
  const param = /^\[(\w+)\]$/.exec(name);
  if (param) return `:${param[1]}`;
  if (name.startsWith("[") || name.startsWith("(")) {
    throw new Error(
      `${file} の名前は、動的な区切り（[id]）、キャッチオール（[...slug]）、グループ（(name)）のどれの形でもありません。パラメータの名前には、英数字と _ を使用してください。`,
    );
  }
  return name;
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
 * 区切りの優先順位を前から比較し、一方が他方の前方と一致するなら短いほうを先にする。
 * 優先順位が同じなら、パスの文字列の順にし、同じパスならファイルのディレクトリが浅いほうを先にする。
 */
function compareRoutes(a: ScannedRoute, b: ScannedRoute): number {
  const left = a.path.split("/");
  const right = b.path.split("/");
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = rankOf(left[index] ?? "") - rankOf(right[index] ?? "");
    if (difference !== 0) return difference;
  }
  if (left.length !== right.length) return left.length - right.length;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.file.split("/").length - b.file.split("/").length;
}

/**
 * プロジェクトのルート `root` からの相対パス `dir` のディレクトリを走査し、ルートの表を返す。
 * ルートは、同じ位置では静的な区切り、動的な区切り、キャッチオールの順に並ぶ。
 * 2 つの `page.tsx` か `route.ts` が同じ URL に対応するときは、エラーを投げる。同じディレクトリに `page.tsx` と `route.ts` を置いたときも、このエラーになる。
 * キャッチオールのディレクトリの配下のディレクトリにルートのファイルがあるときも、エラーを投げる。
 */
export function scanRoutes(root: string, dir: string): ScannedRoutes {
  const routes: ScannedRoute[] = [];
  let middleware: string | undefined;
  const start = resolve(root, dir);
  const fileOf = (path: string): string => relative(root, path).split(sep).join("/");
  const visit = (
    current: string,
    segments: readonly string[],
    outerLayouts: readonly string[],
    outerMiddlewares: readonly string[],
    outerFallbacks: Pick<ScannedRoute, "notFound" | "error">,
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
    const fallbackOf = (name: string) =>
      files.has(name) ? { file: fileOf(join(current, name)), layouts } : undefined;
    const notFound = fallbackOf("not-found.tsx") ?? outerFallbacks.notFound;
    const error = fallbackOf("error.tsx") ?? outerFallbacks.error;
    const fallbacks = {
      ...(notFound !== undefined && { notFound }),
      ...(error !== undefined && { error }),
    };
    const path = `/${segments.join("/")}`;
    for (const [name, kind] of routeFiles) {
      if (files.has(name)) {
        if (segments.slice(0, -1).some(isCatchAll)) {
          throw new Error(
            `${fileOf(join(current, name))} は、キャッチオールのディレクトリの配下にあります。キャッチオールの配下には、ルートのファイルを置けません。`,
          );
        }
        const file = fileOf(join(current, name));
        routes.push({ kind, path, file, layouts, middlewares, ...(kind !== "route" && fallbacks) });
      }
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
        `${other.file} と ${route.file} は、同じ URL に対応します。どちらか一方にしてください。`,
      );
    }
    handled.set(shape, route);
  }
  return {
    routes: routes.toSorted(compareRoutes),
    ...(middleware !== undefined && { middleware }),
  };
}

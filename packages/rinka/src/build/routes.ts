import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { RouteKind } from "../shared/routes.ts";

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
}

/** 走査したルートの表を表す。`middleware` は、ルートのディレクトリの `middleware.ts` である。 */
export interface ScannedRoutes {
  readonly routes: readonly ScannedRoute[];
  readonly middleware?: string;
}

/** ディレクトリにあればルートになるファイルの名前と、その種類である。 */
const routeFiles: readonly (readonly [string, RouteKind])[] = [
  ["page.tsx", "page"],
  ["route.ts", "route"],
  ["not-found.tsx", "not-found"],
  ["error.tsx", "error"],
];

/** ディレクトリの名前を、Hono のパスの区切りにする。グループは `undefined` にする。 */
function segmentOf(name: string): string | undefined {
  if (/^\(.+\)$/.test(name)) return undefined;
  const catchAll = /^\[\.\.\.(\w+)\]$/.exec(name);
  if (catchAll) return `:${catchAll[1]}{.+}`;
  const param = /^\[(\w+)\]$/.exec(name);
  return param ? `:${param[1]}` : name;
}

/** 区切りの優先順位を返す。静的な区切り、動的な区切り、キャッチオールの順に小さい。 */
const rankOf = (segment: string): number =>
  segment.startsWith(":") ? (segment.endsWith("{.+}") ? 2 : 1) : 0;

/** パラメータの名前を除いた、パスが一致する URL の形を返す。 */
const shapeOf = (path: string): string =>
  path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? (segment.endsWith("{.+}") ? "*" : ":") : segment))
    .join("/");

/** 区切りの優先順位を前から比べ、一方が他方の前方と一致するなら短いほうを先にする。 */
function compareRoutes(a: ScannedRoute, b: ScannedRoute): number {
  const left = a.path.split("/");
  const right = b.path.split("/");
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = rankOf(left[index] ?? "") - rankOf(right[index] ?? "");
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * プロジェクトのルート `root` からの相対パス `dir` のディレクトリを走査し、ルートの表を返す。
 * ルートは、同じ位置では静的な区切り、動的な区切り、キャッチオールの順に並ぶ。
 * 同じディレクトリに `page.tsx` と `route.ts` があるときと、2 つのファイルが同じ URL を扱うときは、エラーを投げる。
 */
export function scanRoutes(root: string, dir: string): ScannedRoutes {
  const routes: ScannedRoute[] = [];
  let middleware: string | undefined;
  const fileOf = (path: string): string => relative(root, path).split(sep).join("/");
  const visit = (
    current: string,
    segments: readonly string[],
    outerLayouts: readonly string[],
    outerMiddlewares: readonly string[],
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
      if (current === resolve(root, dir)) middleware = file;
      else middlewares = [...outerMiddlewares, file];
    }
    if (files.has("page.tsx") && files.has("route.ts")) {
      throw new Error(
        `${fileOf(current)} に page.tsx と route.ts の両方があります。どちらか一方にしてください。`,
      );
    }
    const path = `/${segments.join("/")}`;
    for (const [name, kind] of routeFiles) {
      if (files.has(name)) {
        routes.push({ kind, path, file: fileOf(join(current, name)), layouts, middlewares });
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const segment = segmentOf(entry.name);
      visit(
        join(current, entry.name),
        segment === undefined ? segments : [...segments, segment],
        layouts,
        middlewares,
      );
    }
  };
  const start = resolve(root, dir);
  if (existsSync(start)) visit(start, [], [], []);

  const handled = new Map<string, ScannedRoute>();
  for (const route of routes) {
    if (route.kind !== "page" && route.kind !== "route") continue;
    const shape = shapeOf(route.path);
    const other = handled.get(shape);
    if (other) {
      throw new Error(
        `${other.file} と ${route.file} が、同じ URL ${route.path} を扱います。どちらか一方にしてください。`,
      );
    }
    handled.set(shape, route);
  }
  return {
    routes: routes.toSorted(compareRoutes),
    ...(middleware !== undefined && { middleware }),
  };
}

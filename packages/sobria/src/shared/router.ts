import { withBase } from "./base.ts";
import type { ServerNode } from "./nodes.ts";
import { fillPattern } from "./route-segments.ts";

/** ページと `route.ts` のファイルの形のパスごとに、そのルートのパラメータの名前から値への対応を表す。`declare module "sobria/router"` で拡張できる。 */
export interface RouteParams {}

/** `route.ts` のファイルの形のパスごとに、そのルートの Hono のパスを表す。`declare module "sobria/router"` で拡張できる。 */
export interface RouteHandlerPaths {}

/** ページのファイルの形のパスを表す。 */
type PageRoute = Exclude<keyof RouteParams, keyof RouteHandlerPaths>;

/** `Route` のページが受け取る props を表す。`url` はリクエストの URL である。 */
export interface PageProps<Route extends PageRoute> {
  readonly params: RouteParams[Route];
  readonly url: URL;
}

/** レイアウトが受け取る props を表す。`url` はリクエストの URL である。 */
export interface LayoutProps {
  readonly params: Readonly<Record<string, string>>;
  readonly url: URL;
  readonly children: ServerNode;
}

/** `not-found` のページが受け取る props を表す。`url` はリクエストの URL である。 */
export interface NotFoundProps {
  readonly params: Readonly<Record<string, string>>;
  readonly url: URL;
}

/** `error` のページが受け取る props を表す。`error` は投げられた値である。フォームの送信先のサーバー関数が失敗したときは、`url` は送信元のページの URL である。 */
export interface ErrorProps extends NotFoundProps {
  readonly error: unknown;
}

/** `href` が受け取るクエリを表す。 */
type Query = Readonly<Record<string, string | number>> | URLSearchParams;

/** `Route` のパラメータを表す。値には数も指定できる。 */
type Params<Route extends keyof RouteParams> = {
  readonly [Name in keyof RouteParams[Route]]: string | number;
};

/**
 * `Route` のパラメータが無ければ `true` を表す。パラメータのあるページなら、そのパラメータの配列を返す関数を表す。
 * パラメータのある `route.ts` のルートでは `never` を表す。
 */
export type Prerender<Route extends keyof RouteParams> = keyof RouteParams[Route] extends never
  ? true
  : Route extends keyof RouteHandlerPaths
    ? never
    : () => readonly Params<Route>[] | Promise<readonly Params<Route>[]>;

/** `T` が 2 つ以上の型のユニオンかどうかを表す。 */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/** `Route` にパラメータがあれば必須の、`href` の 2 つ目以降の引数を表す。`Route` がユニオンなら、どの引数も受け付けない。 */
type HrefArgs<Route extends keyof RouteParams> =
  true extends IsUnion<Route>
    ? never
    : keyof RouteParams[Route] extends never
      ? [params?: undefined, query?: Query]
      : [params: Params<Route>, query?: Query];

/**
 * ページか `route.ts` のファイルの形のパス `route` とパラメータから、アプリを配置するパス（Vite の `base`）で始まる URL を返す。
 * パラメータの値は URL エンコードし、キャッチオールの値は `/` を区切りとして残す。クエリが空でなければ、`?` に続けて付ける。
 */
export function href<Route extends keyof RouteParams>(
  route: Route,
  ...[params, query]: HrefArgs<Route>
): string {
  const values: Readonly<Record<string, string | number>> = params ?? {};
  const path = fillPattern(String(route), values);
  const search = new URLSearchParams(
    query instanceof URLSearchParams
      ? query
      : Object.entries(query ?? {}).map(([key, value]) => [key, String(value)]),
  ).toString();
  return withBase(search === "" ? path : `${path}?${search}`);
}

import type { ServerNode } from "./nodes.ts";

/** ページのファイルの形のパスから、そのルートのパラメータの名前と値への対応を引く表を表す。`declare module "rinka/router"` で拡張する。 */
export interface RouteParams {}

/** `route` のページが受け取る props を表す。`url` はリクエストの URL である。 */
export interface PageProps<Route extends keyof RouteParams> {
  readonly params: RouteParams[Route];
  readonly url: URL;
}

/** レイアウトが受け取る props を表す。`url` はリクエストの URL である。 */
export interface LayoutProps {
  readonly params: Readonly<Record<string, string>>;
  readonly url: URL;
  readonly children: ServerNode;
}

/** `href` が受け取るクエリを表す。 */
export type Query = Readonly<Record<string, string | number>> | URLSearchParams;

/** `route` のパラメータを表す。値には数も指定できる。 */
type Params<Route extends keyof RouteParams> = {
  readonly [Name in keyof RouteParams[Route]]: string | number;
};

/** `route` にパラメータがあれば必須の、`href` の 2 つ目以降の引数を表す。 */
type HrefArgs<Route extends keyof RouteParams> = keyof RouteParams[Route] extends never
  ? [params?: undefined, query?: Query]
  : [params: Params<Route>, query?: Query];

/**
 * ページのファイルの形のパス `route` とパラメータから、URL を返す。
 * パラメータの値は URL エンコードし、キャッチオールの値は `/` を区切りとして残す。クエリが空でなければ、`?` に続けて付ける。
 */
export function href<Route extends keyof RouteParams>(
  route: Route,
  ...[params, query]: HrefArgs<Route>
): string {
  const values: Readonly<Record<string, string | number>> = params ?? {};
  const path = String(route).replaceAll(
    /\[(\.\.\.)?(\w+)\]/g,
    (_, rest: string | undefined, name: string) => {
      const value = String(values[name]);
      return rest === undefined
        ? encodeURIComponent(value)
        : value.split("/").map(encodeURIComponent).join("/");
    },
  );
  const search = new URLSearchParams(
    query instanceof URLSearchParams
      ? query
      : Object.entries(query ?? {}).map(([key, value]) => [key, String(value)]),
  ).toString();
  return search === "" ? path : `${path}?${search}`;
}

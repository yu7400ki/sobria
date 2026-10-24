/** Vite プラグインの設定 `output` の値である。`static` はサーバーを置かないアプリで、`server` はサーバーを置くアプリである。 */
export type Output = "server" | "static";

/** 書き出すルートの範囲を表す。`static` はすべてのルートで、`server` は `files` のモジュールのルートである。 */
export type PrerenderScope =
  | { readonly output: "static" }
  | { readonly output: "server"; readonly files: readonly string[] };

/** 書き出す URL を、ページか `route.ts` の行ごとに表す。`file` は行のモジュールのファイルである。 */
export interface PrerenderTarget {
  readonly kind: "page" | "route";
  readonly file: string;
  readonly urls: readonly string[];
}

/** 書き出しのリクエストで、サーバーのエントリーの `fetch` の 2 つ目の引数（Hono の env）が、書き出しの種類を値に持つキーである。 */
export const prerenderEnv: unique symbol = Symbol.for("rinka.prerender");

/** 書き出しのリクエストの種類を表す。`page` は書き出す URL の取得で、`not-found` は `404.html` に保存する 404 のページの取得である。 */
export type PrerenderKind = "page" | "not-found";

/** Hono の env `env` が書き出しのリクエストのものなら、その種類を返す。それ以外では `undefined` を返す。 */
export function prerenderKindOf(env: unknown): PrerenderKind | undefined {
  const kind: unknown =
    typeof env === "object" && env !== null ? Reflect.get(env, prerenderEnv) : undefined;
  return kind === "page" || kind === "not-found" ? kind : undefined;
}

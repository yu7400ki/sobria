/** Vite プラグインの設定 `output` の値である。`static` はサーバーを置かないアプリで、`server` はサーバーを置くアプリである。 */
export type Output = "server" | "static";

/** 書き出すルートの範囲を表す。`static` はすべてのルートで、`server` は `files` のモジュールのルートである。 */
export type PrerenderScope =
  | { readonly output: "static" }
  | { readonly output: "server"; readonly files: readonly string[] };

/**
 * 書き出す URL を、書き出しの対象ごとに表す。`page` と `route` はページと `route.ts` の行で、`file` は行のモジュールのファイルである。
 * `not-found` は、`404.html` に保存する 404 のページである。
 */
export type PrerenderTarget =
  | { readonly kind: "page" | "route"; readonly file: string; readonly urls: readonly string[] }
  | { readonly kind: "not-found"; readonly urls: readonly string[] };

/** 書き出しのリクエストで、サーバーのエントリーの `fetch` の 2 つ目の引数（Hono の env）が、書き出しの対象の種類を値に持つキーである。 */
export const prerenderEnv: unique symbol = Symbol.for("rinka.prerender");

/** Hono の env `env` が書き出しのリクエストのものなら、書き出しの対象の種類を返す。それ以外では `undefined` を返す。 */
export function prerenderKindOf(env: unknown): PrerenderTarget["kind"] | undefined {
  const kind: unknown =
    typeof env === "object" && env !== null ? Reflect.get(env, prerenderEnv) : undefined;
  return kind === "page" || kind === "route" || kind === "not-found" ? kind : undefined;
}

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

/** 書き出しのリクエストで、サーバーのエントリーの `fetch` の 2 つ目の引数（Hono の env）が持つキーである。 */
export const prerenderEnv: unique symbol = Symbol.for("rinka.prerender");

/** Hono の env `env` が、書き出しのリクエストのものかどうかを返す。 */
export const isPrerenderEnv = (env: unknown): boolean =>
  typeof env === "object" && env !== null && Reflect.get(env, prerenderEnv) === true;

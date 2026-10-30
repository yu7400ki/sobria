import type { Context } from "hono";

/** リクエスト `c` のメソッドを、HEAD を GET として扱って返す。 */
export const handledMethod = (c: Context): string =>
  c.req.method === "HEAD" ? "GET" : c.req.method;

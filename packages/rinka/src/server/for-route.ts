import { createFactory, type Factory } from "hono/factory";

import type { RouteHandlerPaths } from "../shared/router.ts";

/**
 * `defineHandler` を持つオブジェクトを返す。`defineHandler` は `hono/factory` の `defineHandler` で、
 * 引数のファイルの形のパスの、`RouteHandlerPaths` の Hono のパスを型に持つ。その `defineHandler` で定義した handler の `c.req.param(name)` は、ルートのパラメータの値を `string` で返す。
 */
export function forRoute<Route extends keyof RouteHandlerPaths>(
  _route: Route,
): Pick<Factory<any, RouteHandlerPaths[Route] & string>, "defineHandler"> {
  return createFactory<any, RouteHandlerPaths[Route] & string>();
}

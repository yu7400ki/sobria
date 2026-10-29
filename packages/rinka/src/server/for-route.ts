import { createFactory, type Factory } from "hono/factory";

import type { RouteParams } from "../shared/router.ts";

/** ファイルの形のパスの区切り `Part` を、Hono のパスの区切りにする。 */
type HonoPart<Part extends string> = Part extends `[...${infer Name}]`
  ? `:${Name}{.+}`
  : Part extends `[${infer Name}]`
    ? `:${Name}`
    : Part;

/** ファイルの形のパス `Path` を、Hono のパスにする。 */
type HonoPath<Path extends string> = Path extends `${infer Part}/${infer Rest}`
  ? `${HonoPart<Part>}/${HonoPath<Rest>}`
  : HonoPart<Path>;

/**
 * `defineHandler` を持つオブジェクトを返す。`defineHandler` は `hono/factory` の `defineHandler` で、その型は、ファイルの形のパス `_route` を Hono のパスにした型を持つ。
 * その `defineHandler` で定義した handler の `c.req.param(name)` は、`_route` のパラメータの値を `string` で返す。
 */
export function forRoute<Route extends keyof RouteParams>(
  _route: Route,
): Pick<Factory<any, HonoPath<Route & string>>, "defineHandler"> {
  return createFactory<any, HonoPath<Route & string>>();
}

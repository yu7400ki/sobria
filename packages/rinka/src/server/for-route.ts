import { defineHandler, type Factory } from "hono/factory";

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
 * ファイルの形のパスが `route` のルートの handler を定義する関数を返す。
 * `defineHandler` は `hono/factory` の `defineHandler` で、handler の `c.req.param()` は `route` のパラメータを `string` で返す。
 */
export function forRoute<Route extends keyof RouteParams>(
  _route: Route,
): Pick<Factory<any, HonoPath<Route & string>>, "defineHandler"> {
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  return { defineHandler };
}

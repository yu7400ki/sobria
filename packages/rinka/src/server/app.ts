import { Hono, type Context, type MiddlewareHandler } from "hono";
import { every } from "hono/combine";
import { HTTPException } from "hono/http-exception";

import {
  routeMethods,
  type AppOptions,
  type CreateApp,
  type Load,
  type Route,
  type RouteComponent,
  type Routes,
} from "../shared/routes.ts";
import { runInRequest } from "./context.ts";
import { serverFnMiddleware, withContextHeaders, type Failure } from "./endpoint.ts";
import { jsx } from "./jsx-runtime.ts";
import { renderDocument } from "./render.ts";

/** `HTTPException` はそのレスポンスにし、それ以外は記録して素のテキストの 500 にする。 */
function defaultFailure(error: unknown): Response {
  if (error instanceof HTTPException) return error.getResponse();
  console.error(error);
  return new Response("Internal Server Error", { status: 500 });
}

/** リクエストごとに `load` でミドルウェアを読み込んで実行するミドルウェアを返す。 */
const lazy =
  (load: Load<MiddlewareHandler>): MiddlewareHandler =>
  async (c, next) => {
    const { default: middleware } = await load();
    return middleware(c, next);
  };

/** `next()` だけを呼ぶミドルウェアである。 */
const passThrough: MiddlewareHandler = async (_c, next) => {
  await next();
};

/** ページとレイアウトが受け取る、リクエストの props を返す。 */
const propsOf = (c: Context) => ({ params: c.req.param(), url: new URL(c.req.url) });

/** `page` を、外側から順に並んだ `layouts` で包んだノードを返す。 */
async function wrap(
  page: Load<RouteComponent>,
  layouts: readonly Load<RouteComponent>[],
  props: object,
): Promise<unknown> {
  const [{ default: component }, ...outer] = await Promise.all([
    page(),
    ...layouts.map((load) => load()),
  ]);
  return outer.reduceRight<unknown>(
    (children, { default: layout }) => jsx(layout, { ...props, children }),
    jsx(component, props),
  );
}

/** ルートの表から、各ページと `route.ts` を登録した Hono のアプリを作成する。 */
export const createApp = (({ routes, middleware }: Routes, options: AppOptions = {}): Hono => {
  const app = new Hono();
  const handle = options.onError ?? defaultFailure;
  const fail: Failure = (error, c) => withContextHeaders(c, handle(error));
  app.onError((c) => {
    const response = handle(c.error);
    return c.newResponse(response.body, response);
  });
  const rinka = every(
    middleware === undefined ? passThrough : lazy(middleware),
    serverFnMiddleware(options, fail),
  );
  app.use((c, next) => runInRequest(c, () => rinka(c, next)));
  for (const route of routes) register(app, route, options);
  return app;
}) satisfies CreateApp;

/** `route` を、ディレクトリのミドルウェアの後に `app` に登録する。 */
function register(app: Hono, route: Route, options: AppOptions): void {
  const middlewares = every(...route.middlewares.map(lazy));
  switch (route.kind) {
    case "page":
      app.get(route.path, middlewares, async (c) => {
        const response = await renderDocument(await wrap(route.load, route.layouts, propsOf(c)), {
          ...(options.head !== undefined && { head: options.head }),
        });
        return c.newResponse(response.body, response);
      });
      return;
    case "route":
      app.on([...routeMethods], route.path, middlewares, async (c, next) => {
        const handlers = await route.load();
        const method = routeMethods.find((name) => name === c.req.method);
        const handler = method === undefined ? undefined : handlers[method];
        if (handler === undefined) {
          const allow = routeMethods.filter((name) => handlers[name] !== undefined).join(", ");
          return c.body(null, 405, { allow });
        }
        const result: unknown = await handler(c, next);
        if (result instanceof Response) return result;
        return result === undefined ? c.body(null, 204) : c.json(result);
      });
      return;
    case "not-found":
    case "error":
      return;
  }
}

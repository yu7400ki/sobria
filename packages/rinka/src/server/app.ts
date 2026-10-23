import { Hono, type Context, type MiddlewareHandler } from "hono";
import { every } from "hono/combine";
import { HTTPException } from "hono/http-exception";

import {
  routeMethods,
  type AppOptions,
  type CreateApp,
  type Fallback,
  type Load,
  type Route,
  type RouteComponent,
  type Routes,
} from "../shared/routes.ts";
import { runInRequest, withContextHeaders } from "./context.ts";
import { serverFnMiddleware } from "./endpoint.ts";
import { notFound } from "./errors.ts";
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

/** ページの描画で使用する `not-found.tsx` と `error.tsx` を表す。 */
interface Fallbacks {
  readonly notFound?: Fallback;
  readonly error?: Fallback;
}

/** エラーのページを、そのレイアウトで包み、`props` を渡して描画するノードを返す。 */
const fallbackNode = (page: Fallback, props: object): unknown =>
  jsx(() => wrap(page.module, page.layouts, props), {});

/** `notFound()` を投げるページである。 */
const missing = (): never => {
  throw notFound();
};

/** ルートの表から、各ページと `route.ts` を登録した Hono のアプリを作成する。 */
export const createApp = (({ routes, middleware }: Routes, options: AppOptions = {}): Hono => {
  const app = new Hono();
  const handle = options.onError ?? defaultFailure;
  app.onError((c) => withContextHeaders(c, handle(c.error)));
  const serverFns = serverFnMiddleware(options, handle);
  const rinka = middleware === undefined ? serverFns : every(lazy(middleware), serverFns);
  app.use((c, next) => runInRequest(c, () => rinka(c, next)));
  const respond: Respond = async (c, node, { notFound: missingPage, error: errorPage }, props) => {
    const response = await renderDocument(node, {
      ...(options.head !== undefined && { head: options.head }),
      ...(missingPage && { notFound: () => fallbackNode(missingPage, props) }),
      ...(errorPage && {
        error: (error: unknown) => {
          console.error(error);
          return fallbackNode(errorPage, { ...props, error });
        },
      }),
    });
    return withContextHeaders(c, response);
  };
  for (const route of routes) register(app, route, respond);
  app.notFound((c) => respond(c, jsx(missing, {}), {}, {}));
  return app;
}) satisfies CreateApp;

/**
 * `node` を描画した文書を、`c` のリクエストのレスポンスとして返す関数を表す。
 * `fallbacks` の `not-found.tsx` と `error.tsx` には、`props` を渡す。
 */
type Respond = (
  c: Pick<Context, "req" | "newResponse">,
  node: unknown,
  fallbacks: Fallbacks,
  props: object,
) => Promise<Response>;

/** `route` を、ディレクトリのミドルウェアの後に `app` に登録する。 */
function register(app: Hono, route: Route, respond: Respond): void {
  const directory = every(...route.middlewares.map(lazy));
  switch (route.kind) {
    case "page":
      app.get(route.path, directory, async (c) => {
        const props = propsOf(c);
        return respond(c, await wrap(route.module, route.layouts, props), route, props);
      });
      return;
    case "route":
      app.all(route.path, directory, async (c, next) => {
        const handlers = await route.module();
        const requested = c.req.method === "HEAD" ? "GET" : c.req.method;
        const method = routeMethods.find((name) => name === requested);
        const handler = method === undefined ? undefined : handlers[method];
        if (handler === undefined) {
          const allow = routeMethods
            .filter((name) => handlers[name] !== undefined)
            .flatMap((name) => (name === "GET" ? ["GET", "HEAD"] : [name]))
            .join(", ");
          return c.body(null, 405, { allow });
        }
        const result: unknown = await handler(c, next);
        if (result instanceof Response) return withContextHeaders(c, result);
        return result === undefined ? c.body(null, 204) : c.json(result);
      });
      return;
    case "not-found":
      app.all(route.path, directory, async (c) => {
        const fallbacks: Fallbacks = {
          notFound: { module: route.module, layouts: route.layouts },
          ...(route.error && { error: route.error }),
        };
        return respond(c, jsx(missing, {}), fallbacks, propsOf(c));
      });
      return;
  }
}

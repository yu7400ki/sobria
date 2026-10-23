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

/** `pattern` の区切りが `segments` の前方と一致すれば、そのパラメータを返す。 */
function matchPrefix(
  pattern: string,
  segments: readonly string[],
): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  for (const [index, part] of segmentsOf(pattern).entries()) {
    const segment = segments[index];
    if (segment === undefined) return undefined;
    if (part.endsWith("{.+}"))
      params[part.slice(1, -"{.+}".length)] = segments.slice(index).join("/");
    else if (part.startsWith(":")) params[part.slice(1)] = segment;
    else if (part !== segment) return undefined;
  }
  return params;
}

/** パスを、空でない区切りに分ける。 */
const segmentsOf = (path: string): string[] => path.split("/").filter((segment) => segment !== "");

/** エラーのページの行と、URL から取り出したパラメータを表す。 */
interface Fallback {
  readonly route: Exclude<Route, { readonly kind: "route" }>;
  readonly params: Record<string, string>;
}

/** `kind` の行のうち、`url` の区切りが前方から一致し、区切りの数が最も多いものを、そのパラメータとともに返す。 */
function nearest(
  routes: readonly Route[],
  kind: "not-found" | "error",
  url: URL,
): Fallback | undefined {
  const segments = segmentsOf(url.pathname);
  let found: Fallback | undefined;
  for (const route of routes) {
    if (route.kind === "route" || route.kind !== kind) continue;
    const params = matchPrefix(route.path, segments);
    if (params && (!found || segmentsOf(route.path).length > segmentsOf(found.route.path).length)) {
      found = { route, params };
    }
  }
  return found;
}

/** エラーのページを、そのレイアウトで包み、パラメータと `url` と `props` を渡して描画するノードを返す。 */
const fallback = ({ route, params }: Fallback, url: URL, props: object): unknown =>
  jsx(() => wrap(route.load, route.layouts, { params, url, ...props }), {});

/** `notFound()` を投げるページである。表に無い URL に使用する。 */
const missing = (): never => {
  throw notFound();
};

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
  const respond: Respond = async (c, node) => {
    const url = new URL(c.req.url);
    const missingPage = nearest(routes, "not-found", url);
    const errorPage = nearest(routes, "error", url);
    const response = await renderDocument(node, {
      ...(options.head !== undefined && { head: options.head }),
      ...(missingPage && { notFound: () => fallback(missingPage, url, {}) }),
      ...(errorPage && { error: (error: unknown) => fallback(errorPage, url, { error }) }),
    });
    return c.newResponse(response.body, response);
  };
  for (const route of routes) register(app, route, respond);
  app.notFound((c) => respond(c, jsx(missing, {})));
  return app;
}) satisfies CreateApp;

/** `node` を描画した文書を、`c` のリクエストのレスポンスとして返す関数を表す。 */
type Respond = (c: Pick<Context, "req" | "newResponse">, node: unknown) => Promise<Response>;

/** `route` を、ディレクトリのミドルウェアの後に `app` に登録する。 */
function register(app: Hono, route: Route, respond: Respond): void {
  const middlewares = every(...route.middlewares.map(lazy));
  switch (route.kind) {
    case "page":
      app.get(route.path, middlewares, async (c) =>
        respond(c, await wrap(route.load, route.layouts, propsOf(c))),
      );
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

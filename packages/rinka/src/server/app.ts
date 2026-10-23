import { Hono, type Context, type MiddlewareHandler } from "hono";
import { every } from "hono/combine";
import { HTTPException } from "hono/http-exception";

import { REFRESH_HEADER } from "../shared/refresh.ts";
import {
  routeMethods,
  type AppOptions,
  type CreateApp,
  type Fallback,
  type Fallbacks,
  type Load,
  type Route,
  type RouteComponent,
  type Routes,
} from "../shared/routes.ts";
import { runInRequest, withContextHeaders } from "./context.ts";
import { serverFnMiddleware, type FormFailure } from "./endpoint.ts";
import { notFound } from "./errors.ts";
import { jsx } from "./jsx-runtime.ts";
import { renderDocument, renderRefresh } from "./render.ts";
import { withDepth } from "./tree.ts";

/** `HTTPException` はそのレスポンスにし、それ以外は記録して素のテキストの 500 にする。 */
function defaultFailure(error: unknown): Response {
  if (error instanceof HTTPException) return error.getResponse();
  console.error(error);
  return new Response("Internal Server Error", { status: 500 });
}

/** リクエストごとに `load` でミドルウェアを読み込んで実行するミドルウェアを返す。ミドルウェアが返した Response には、Context で設定したヘッダーを加える。 */
const lazy =
  (load: Load<MiddlewareHandler>): MiddlewareHandler =>
  async (c, next) => {
    const { default: middleware } = await load();
    const result = await middleware(c, next);
    return result instanceof Response ? withContextHeaders(c, result) : result;
  };

/** ページとレイアウトが受け取る、リクエストの props を返す。 */
const propsOf = (c: Context) => ({ params: c.req.param(), url: new URL(c.req.url) });

/** `page` を、外側から順に並んだ `layouts` で包んだノードを返す。各ファイルの描画には、外側から順に 0 から始まる深さを与える。 */
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
    (children, { default: layout }, depth) => withDepth(depth, jsx(layout, { ...props, children })),
    withDepth(outer.length, jsx(component, props)),
  );
}

/** エラーのページを、そのレイアウトで包み、`props` を渡して描画するノードを返す。 */
const fallbackNode = (page: Fallback, props: object): unknown =>
  jsx(() => wrap(page.module, page.layouts, props), {});

/** `error` を投げるコンポーネントを返す。 */
const throwing = (error: unknown) => (): never => {
  throw error;
};

/** URL に一致したページか `not-found.tsx` の行と、そのパラメータを表す。 */
interface Found {
  readonly route: Extract<Route, { kind: "page" | "not-found" }>;
  readonly params: Record<string, string>;
}

/** ページと `not-found.tsx` の行を、`app` と同じ順序で登録し、URL に一致する最初の行を返す関数を作成する。 */
function finder(routes: readonly Route[]): (url: URL) => Promise<Found | undefined> {
  const rows = new Hono<{ Bindings: { found?: Found } }>();
  for (const route of routes) {
    if (route.kind === "route") continue;
    rows.get(route.path, (c) => {
      c.env.found = { route, params: c.req.param() };
      return c.body(null);
    });
  }
  return async (url) => {
    const box: { found?: Found } = {};
    await rows.fetch(new Request(url), box);
    return box.found;
  };
}

/** `notFound()` を投げるページである。 */
const missing = (): never => {
  throw notFound();
};

/** ルートの表から、各ページと `route.ts` を登録した Hono のアプリを作成する。 */
export const createApp = (({ routes, middleware }: Routes, options: AppOptions = {}): Hono => {
  const app = new Hono();
  const handle = options.onError ?? defaultFailure;
  app.onError((c) => withContextHeaders(c, handle(c.error)));
  const find = finder(routes);
  const formFailure: FormFailure = async (c, error) => {
    const referer = c.req.header("referer");
    const url = referer !== undefined && URL.canParse(referer) ? new URL(referer) : undefined;
    if (url === undefined || url.origin !== new URL(c.req.url).origin) return handle(error);
    const found = await find(url);
    if (found?.route.error === undefined) return handle(error);
    return respond(
      c,
      jsx(throwing(error), {}),
      { error: found.route.error },
      {
        params: found.params,
        url,
      },
    );
  };
  const serverFns = serverFnMiddleware(options, handle, formFailure);
  const rinka = middleware === undefined ? serverFns : every(lazy(middleware), serverFns);
  app.use((c, next) => runInRequest(c, () => rinka(c, next)));
  const respond: Respond = async (c, node, { notFound: missingPage, error: errorPage }, props) => {
    const pages = {
      headers: { vary: REFRESH_HEADER },
      ...(missingPage && { notFound: () => fallbackNode(missingPage, props) }),
      ...(errorPage && {
        error: (error: unknown) => {
          console.error(error);
          return fallbackNode(errorPage, { ...props, error });
        },
      }),
    };
    const response =
      c.req.header(REFRESH_HEADER) === "1"
        ? await renderRefresh(node, pages)
        : await renderDocument(node, {
            ...pages,
            ...(options.head !== undefined && { head: options.head }),
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
      app.all(route.path, directory, async (c) => respond(c, jsx(missing, {}), route, propsOf(c)));
      return;
  }
}

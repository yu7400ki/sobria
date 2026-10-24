import { Hono, type Context, type MiddlewareHandler } from "hono";
import { every } from "hono/combine";

import { prerenderKindOf, type Output } from "../shared/prerender.ts";
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
import { isBot } from "./bots.ts";
import { blockingRenderOf, runInRequest, withContextHeaders } from "./context.ts";
import {
  formRedirects,
  serverFnFailure,
  serverFnMiddleware,
  type Failure,
  type Failures,
} from "./endpoint.ts";
import { classify, notFound } from "./errors.ts";
import { stylesheetLink } from "./html.ts";
import { jsx } from "./jsx-runtime.ts";
import { prerenderParams } from "./prerender.ts";
import { handledMethod } from "./request.ts";
import { renderDocument, renderRefresh } from "./response.ts";
import { withDepth } from "./tree.ts";

/** エラーを記録して、素のテキストの 500 にする。 */
function defaultFailure(error: unknown): Response {
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

/**
 * サーバー関数のエンドポイントへのリクエストでは、ミドルウェア `middleware` が投げた値を、`failures` を使用して、サーバー関数が投げた値と同じレスポンスにするミドルウェアを返す。
 * `middleware` が、`next()` が投げた値と同じ値を投げたときは、その値をそのまま投げる。
 */
const root =
  (middleware: MiddlewareHandler, failures: Failures): MiddlewareHandler =>
  async (c, next) => {
    let downstream: { readonly error: unknown } | undefined;
    try {
      return await middleware(c, async () => {
        try {
          await next();
        } catch (error) {
          downstream = { error };
          throw error;
        }
      });
    } catch (error) {
      const response =
        downstream !== undefined && downstream.error === error
          ? undefined
          : serverFnFailure(c, error, failures);
      if (response === undefined) throw error;
      return response;
    }
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

/** ページと `not-found.tsx` の行を、`createApp` がページを登録するのと同じ順序で登録し、URL に一致する最初の行を返す関数を作成する。 */
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
  const onError = options.onError ?? defaultFailure;
  const respond: Respond = async (
    c,
    node,
    { notFound: missingPage, error: errorPage },
    props,
    files = [],
  ) => {
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
    if (c.req.header(REFRESH_HEADER) === "1") {
      return withContextHeaders(c, await renderRefresh(node, pages));
    }
    const styles = options.styles && files.length > 0 ? await options.styles(files) : [];
    const head = `${options.head ?? ""}${styles.map(stylesheetLink).join("")}`;
    const response = await renderDocument(node, {
      ...pages,
      blocking:
        prerenderKindOf(c.env) !== undefined ||
        (blockingRenderOf(c) ?? isBot(c.req.header("user-agent"))),
      ...(head !== "" && { head }),
    });
    return withContextHeaders(c, response);
  };
  const find = finder(routes);
  /**
   * ミドルウェア、`route.ts`、サーバー関数が投げた値と、`error.tsx` の無いページの描画で投げた値から、リクエスト `c` のレスポンスを作成する。
   * `redirect()` と `HTTPException` は、そのレスポンスを返す。`notFound()` は、URL に一致する `not-found.tsx` のページを 404 で返す。そのほかの値は `onError` に渡す。
   */
  const fail = async (
    c: Pick<Context, "req" | "newResponse" | "env">,
    error: unknown,
  ): Promise<Response> => {
    const thrown = classify(error);
    switch (thrown.kind) {
      case "redirect":
      case "moved":
      case "response":
        return thrown.response;
      case "notFound": {
        const url = new URL(c.req.url);
        const found = await find(url);
        return respond(c, jsx(missing, {}), found?.route ?? {}, {
          params: found?.params ?? {},
          url,
        });
      }
      case "schema":
      case "error":
        return onError(error);
    }
  };
  const formFailure: Failure = async (c, error) => {
    const referer = c.req.header("referer");
    const url = referer !== undefined && URL.canParse(referer) ? new URL(referer) : undefined;
    if (url === undefined || url.host !== new URL(c.req.url).host) return fail(c, error);
    const found = await find(url);
    if (found?.route.error === undefined) return fail(c, error);
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
  app.onError(async (c) => withContextHeaders(c, await fail(c, c.error)));
  const failures = { rpc: fail, form: formFailure };
  const serverFns = serverFnMiddleware(options, failures);
  const rinka =
    middleware === undefined ? serverFns : every(root(lazy(middleware), failures), serverFns);
  app.use(formRedirects);
  app.use((c, next) =>
    runInRequest(c, () =>
      rinka(
        c,
        prerenderKindOf(c.env) === "not-found"
          ? async () => {
              // 404.html の書き出しのリクエストでは、ルートのミドルウェアの後で not-found.tsx を描画する
              c.res = await fail(c, notFound());
            }
          : next,
      ),
    ),
  );
  for (const route of routes) register(app, route, respond, options.output ?? "server");
  app.notFound((c) => respond(c, jsx(missing, {}), {}, {}));
  return app;
}) satisfies CreateApp;

/**
 * `node` を描画した文書を、`c` のリクエストのレスポンスとして返す関数を表す。
 * `fallbacks` の `not-found.tsx` と `error.tsx` には、`props` を渡す。
 */
type Respond = (
  c: Pick<Context, "req" | "newResponse" | "env">,
  node: unknown,
  fallbacks: Fallbacks,
  props: object,
  files?: readonly string[],
) => Promise<Response>;

/**
 * `route` を、ディレクトリのミドルウェアの後に `app` に登録する。
 * `output` が `static` なら、パラメータのあるページのリクエストのパラメータが、そのページの `prerender` が返すパラメータに無いときに、`notFound()` を投げる。
 */
function register(app: Hono, route: Route, respond: Respond, output: Output): void {
  const directory = every(...route.middlewares.map(lazy));
  switch (route.kind) {
    case "page":
      app.get(route.path, directory, async (c) => {
        if (output === "static") {
          const list = await prerenderParams(route);
          const params: Readonly<Record<string, string>> = c.req.param();
          const listed = list?.some(({ values }) =>
            Object.entries(values).every(([name, value]) => params[name] === value),
          );
          if (listed === false) throw notFound();
        }
        const props = propsOf(c);
        return respond(
          c,
          await wrap(route.module, route.layouts, props),
          route,
          props,
          [...route.layouts, route.module].map((load) => load.file),
        );
      });
      return;
    case "route":
      app.all(route.path, directory, async (c, next) => {
        const handlers = await route.module();
        const requested = handledMethod(c);
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

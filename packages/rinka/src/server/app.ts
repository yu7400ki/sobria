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
  callerOf,
  callerResponses,
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
import { renderDocument, renderRefresh, type DocumentPage } from "./response.ts";
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

/** ページ `page` と、外側から順に並んだ `layouts` のファイルを、外側から順に返す。 */
const filesOf = (page: Load<RouteComponent>, layouts: readonly Load<RouteComponent>[]): string[] =>
  [...layouts, page].map((load) => load.file);

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

/** リクエスト `c` の `executionCtx` を返す。無ければ `undefined` を返す。 */
function executionCtxOf(c: Context): Context["executionCtx"] | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/** `notFound()` を投げるページである。 */
const missing = (): never => {
  throw notFound();
};

/** ルートの表から、各ページと `route.ts` を登録した Hono のアプリを作成する。 */
export const createApp = (({ routes, middleware }: Routes, options: AppOptions = {}): Hono => {
  const app = new Hono();
  const onError = options.onError ?? defaultFailure;
  /** ページとレイアウトのファイル `files` が import した CSS の `<link>` を、`options.head` の後に連結したマークアップを返す。 */
  const headOf = async (files: readonly string[]): Promise<string> => {
    const styles = options.styles && files.length > 0 ? await options.styles(files) : [];
    return `${options.head ?? ""}${styles.map(stylesheetLink).join("")}`;
  };
  /** エラーのページを、そのレイアウトで包み、`props` を渡して描画する文書の内容を返す。 */
  const fallbackPage = async (page: Fallback, props: object): Promise<DocumentPage> => {
    const node = await wrap(page.module, page.layouts, props);
    return { node, head: await headOf(filesOf(page.module, page.layouts)) };
  };
  const respond: Respond = async (
    c,
    node,
    { notFound: missingPage, error: errorPage },
    props,
    { files = [], refresh = c.req.header(REFRESH_HEADER) === "1" } = {},
  ) => {
    const headers = { vary: REFRESH_HEADER };
    /** `error.tsx` に渡す props を返す。投げられた値 `error` は記録する。 */
    const errorProps = (error: unknown): object => {
      console.error(error);
      return { ...props, error };
    };
    if (refresh) {
      const response = await renderRefresh(node, {
        headers,
        ...(missingPage && { notFound: () => fallbackNode(missingPage, props) }),
        ...(errorPage && { error: (error: unknown) => fallbackNode(errorPage, errorProps(error)) }),
      });
      return withContextHeaders(c, response);
    }
    const response = await renderDocument(
      { node, head: await headOf(files) },
      {
        headers,
        ...(missingPage && { notFound: () => fallbackPage(missingPage, props) }),
        ...(errorPage && { error: (error: unknown) => fallbackPage(errorPage, errorProps(error)) }),
        blocking:
          prerenderKindOf(c.env) !== undefined ||
          (blockingRenderOf(c) ?? isBot(c.req.header("user-agent"))),
      },
    );
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
    const caller = callerOf(c);
    const referer = c.req.header("referer");
    const url =
      caller?.page ??
      (referer !== undefined && URL.canParse(referer) ? new URL(referer) : undefined);
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
      { refresh: caller !== undefined },
    );
  };
  app.onError(async (c) => withContextHeaders(c, await fail(c, c.error)));
  const failures = { rpc: fail, form: formFailure };
  const serverFns = serverFnMiddleware(options, failures);
  const rinka =
    middleware === undefined ? serverFns : every(root(lazy(middleware), failures), serverFns);
  app.use(callerResponses((c, request) => app.fetch(request, c.env, executionCtxOf(c))));
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
 * `fallbacks` の `not-found.tsx` と `error.tsx` には、`props` を渡す。`files` は、スタイルシートを読み込むモジュールのファイルである。
 * `refresh` が真なら、描き直しの JSON で返す。`refresh` のデフォルト値は、リクエストが `x-rinka-refresh: 1` を持つかどうかである。
 */
type Respond = (
  c: Pick<Context, "req" | "newResponse" | "env">,
  node: unknown,
  fallbacks: Fallbacks,
  props: object,
  options?: { readonly files?: readonly string[]; readonly refresh?: boolean },
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
        return respond(c, await wrap(route.module, route.layouts, props), route, props, {
          files: filesOf(route.module, route.layouts),
        });
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

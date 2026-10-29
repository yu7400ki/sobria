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
import {
  blockingRenderOf,
  executionCtxOf,
  replaceResponse,
  runInRequest,
  withContextHeaders,
} from "./context.ts";
import {
  acceptsSubmission,
  callerResponses,
  identifyCall,
  pageRequest,
  refusesSubmission,
  serverFnFailure,
  serverFnMiddleware,
  submittedPage,
  type Failure,
  type Submitted,
  type FetchPage,
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
 * ミドルウェア `middleware` が投げた値を `handle` に渡し、`handle` が返した Response を、`next()` の後で投げたときも含めてレスポンスにするミドルウェアを返す。
 * `handle` が `undefined` を返したとき、または `middleware` が `next()` の投げた値と同じ値を投げたときは、`middleware` が投げた値をそのまま投げる。
 */
const catching =
  (
    middleware: MiddlewareHandler,
    handle: (c: Context, error: unknown) => Response | Promise<Response> | undefined,
  ): MiddlewareHandler =>
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
        downstream !== undefined && downstream.error === error ? undefined : handle(c, error);
      if (response === undefined) throw error;
      return replaceResponse(c, response);
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

/** `notFound()` を投げるページである。 */
const missing = (): never => {
  throw notFound();
};

/** フォームの送信 `c` が JS からの送信かどうかと、送信したページへのサブリクエストを返す。送信したページが無ければ `undefined` を返す。 */
function submittedRequest(c: Context) {
  const { js, page } = submittedPage(c);
  return page === undefined ? undefined : { js, request: pageRequest(c, page, js) };
}

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
  /**
   * ミドルウェア、`route.ts`、サーバー関数が投げた値と、`error.tsx` の無いページの描画で投げた値から、リクエスト `c` のレスポンスを作成する。
   * `redirect()` と `HTTPException` はそれぞれが表すレスポンスにし、`notFound()` は `Not Found` のテキストの 404 にし、そのほかの値は `onError` に渡す。
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
      case "notFound":
        return respond(c, jsx(missing, {}), {}, {});
      case "schema":
      case "error":
        return onError(error);
    }
  };
  /** 送信したページへのサブリクエストの `Request` をキーにして、フォームの送信先のサーバー関数が投げた値を保持する。 */
  const formErrors = new WeakMap<Request, { readonly error: unknown }>();
  /** `c` が保持する `Request` をキーにした、サーバー関数が投げた値を、`formErrors` から除去して返す。キーに対応する値が無ければ `undefined` を返す。 */
  const takeFormError = (c: Pick<Context, "req">): { readonly error: unknown } | undefined => {
    const failed = formErrors.get(c.req.raw);
    formErrors.delete(c.req.raw);
    return failed;
  };
  /** サブリクエスト `request` を、リクエスト `c` と同じ env と executionCtx で、このアプリに送信する。 */
  const fetchPage: FetchPage = (c, request) => app.fetch(request, c.env, executionCtxOf(c));
  /** フォームの送信 `c` の、送信したページへのサブリクエスト `request` のレスポンスを返す。JS が無いときは、307 と 308 のリダイレクトを 303 に変換する。 */
  const submittedResponse = async (
    c: Context,
    { js, request }: { readonly js: boolean; readonly request: Request },
  ): Promise<Response> => {
    const response = await fetchPage(c, request);
    const resend = !js && (response.status === 307 || response.status === 308);
    return withContextHeaders(
      c,
      resend ? new Response(response.body, { status: 303, headers: response.headers }) : response,
    );
  };
  const formFailure: Failure = async (c, error) => {
    const submitted = submittedRequest(c);
    if (submitted === undefined) return fail(c, error);
    formErrors.set(submitted.request, { error });
    const response = await submittedResponse(c, submitted);
    // error.tsx と onError のどちらにも渡らなかった値は、ここで記録する
    if (formErrors.has(submitted.request)) console.error(error);
    return response;
  };
  const formSubmitted: Submitted = async (c, { js, page }) =>
    submittedResponse(c, { js, request: pageRequest(c, page, js) });
  app.onError(async (c) => withContextHeaders(c, await fail(c, c.error)));
  const failures = { rpc: fail, form: formFailure };
  const serverFns = serverFnMiddleware(options, failures, formSubmitted);
  const rinka =
    middleware === undefined
      ? every(identifyCall, serverFns)
      : every(
          identifyCall,
          // サーバー関数を呼び出すリクエストでは、ルートのミドルウェアが投げた値を、サーバー関数が投げた値と同じレスポンスにする
          catching(lazy(middleware), (c, error) => serverFnFailure(c, error, failures)),
          serverFns,
        );
  // URL の区切りの無い not-found.tsx の行のうち、ルートの表で最初の行である。グループの外のものが先に並ぶ
  const rootMissing = routes.find((route) => route.kind === "not-found" && route.path === "/*");
  app.use(callerResponses(fetchPage));
  app.use((c, next) =>
    runInRequest(c, () =>
      rinka(
        c,
        prerenderKindOf(c.env) === "not-found"
          ? async () => {
              // 404.html の書き出しのリクエストでは、ルートの middleware.ts の後で、rootMissing の行の middleware.ts を実行してから描画する
              const props = { params: {}, url: new URL(c.req.url) };
              await directoryOf(respond, rootMissing?.middlewares ?? [])(c, async () => {
                await replaceResponse(c, respond(c, jsx(missing, {}), rootMissing ?? {}, props));
              });
            }
          : next,
      ),
    ),
  );
  for (const route of routes) {
    register(app, route, respond, options.output ?? "server", takeFormError);
  }
  app.notFound((c) => {
    // 一致する行が無い URL へのフォームの失敗のサブリクエストでは、投げた値を app.onError に渡す
    const failed = takeFormError(c);
    if (failed) throw failed.error;
    return respond(c, jsx(missing, {}), {}, {});
  });
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

/** `notFound()` を受け取ったときは `fallbacks` の `not-found.tsx` を描画した 404 を、そのほかの値を受け取ったときは `undefined` を返す関数を返す。 */
const notFoundWith = (respond: Respond, fallbacks: Fallbacks) => (c: Context, error: unknown) =>
  classify(error).kind === "notFound"
    ? respond(c, jsx(missing, {}), fallbacks, propsOf(c))
    : undefined;

/** ディレクトリのミドルウェア `middlewares` を外側から順に実行するミドルウェアを返す。ミドルウェアが投げた `notFound()` には、そのミドルウェアに付与した `not-found.tsx` を使用する。 */
const directoryOf = (respond: Respond, middlewares: Route["middlewares"]): MiddlewareHandler =>
  every(
    ...middlewares.map((middleware) =>
      catching(lazy(middleware.module), notFoundWith(respond, middleware)),
    ),
  );

/**
 * `route` を、ディレクトリのミドルウェアの後に `app` に登録する。
 * ページと `not-found.tsx` の行の先頭には、フォームの送信を受け付ける印の `acceptsSubmission` を、`route.ts` の行の先頭には `refusesSubmission` を登録する。ページの行の POST には、ディレクトリのミドルウェアを登録しない。
 * `formErrorOf` がそのリクエストに対して値を返したら、行の処理を実行せずに、ページと `not-found.tsx` の行では行の `error.tsx` にその値を渡して描画し、`error.tsx` が無い行と `route.ts` の行ではその値を投げる。
 * 行の処理が投げた `notFound()` には、行の `not-found.tsx` を使用する。
 * `output` が `static` なら、パラメータのあるページのリクエストのパラメータが、そのページの `prerender` が返すパラメータに無いときに、`notFound()` を投げる。
 */
function register(
  app: Hono,
  route: Route,
  respond: Respond,
  output: Output,
  formErrorOf: (c: Context) => { readonly error: unknown } | undefined,
): void {
  const directory = directoryOf(respond, route.middlewares);
  /** 行の処理 `handler` を、`directory` の後に実行するハンドラーの列を返す。`errorPage` は、フォームの失敗のサブリクエストに描画する `error.tsx` で、`undefined` なら、サーバー関数が投げた値を投げる。 */
  const chain = (handler: MiddlewareHandler, errorPage: Fallback | undefined) =>
    [
      directory,
      catching(
        async (c, next) => {
          const failed = formErrorOf(c);
          if (failed === undefined) return handler(c, next);
          if (errorPage === undefined) throw failed.error;
          return respond(c, jsx(throwing(failed.error), {}), { error: errorPage }, propsOf(c));
        },
        notFoundWith(respond, route),
      ),
    ] as const;
  switch (route.kind) {
    case "page":
      app.get(
        route.path,
        ...chain(async (c) => {
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
        }, route.error),
      );
      app.post(route.path, acceptsSubmission);
      return;
    case "route":
      app.all(
        route.path,
        refusesSubmission,
        ...chain(async (c, next) => {
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
        }, undefined),
      );
      return;
    case "not-found":
      app.all(
        route.path,
        acceptsSubmission,
        ...chain(async (c) => respond(c, jsx(missing, {}), route, propsOf(c)), route.error),
      );
      return;
  }
}

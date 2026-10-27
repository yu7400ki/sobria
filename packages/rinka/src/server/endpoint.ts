import type { Context, MiddlewareHandler } from "hono";

import { isAsyncIterable, isPlainObject } from "../shared/objects.ts";
import { PAGE_HEADER, REFRESH_HEADER, sameDocument } from "../shared/refresh.ts";
import type { AppOptions } from "../shared/routes.ts";
import {
  moduleOfServerFnId,
  withServerFnRef,
  type serverFnRef,
  type ServerFnRef,
} from "../shared/server-fn.ts";
import {
  internalPrefix,
  rpcPrefix,
  rpcQuery,
  isEndOrRedirectLineText,
  isRedirectJson,
  splitLines,
  streamLineText,
  wireFormat,
  wireHeader,
  type RedirectJson,
  type StreamLine,
} from "../shared/wire.ts";
import { replaceResponse, runInRequest } from "./context.ts";
import { cookieAfter } from "./cookies.ts";
import { classify, isSafeLocation, navigableLocation } from "./errors.ts";
import { formDataToInput } from "./form-data.ts";
import { Relay } from "./relay.ts";
import { handledMethod } from "./request.ts";
import { definitionOf, runChain, SchemaError, type Definition } from "./server-fn.ts";
import { fromRpcInput, toRpcBody } from "./wire.ts";

const registry = new Map<string, Definition>();

/** `fn` を、ID が `id` のサーバー関数として登録し、`fn` を返す。 */
export function registerServerFn<F extends { readonly [serverFnRef]: ServerFnRef }>(
  id: string,
  fn: F,
): F {
  const definition = definitionOf(fn);
  if (!definition)
    throw new TypeError("registerServerFn には、defineServerFn が作成した関数を渡してください。");
  registry.set(id, definition);
  return withServerFnRef(fn, { id, method: definition.method });
}

/** ID のモジュールの部分が `fnModule` のサーバー関数の登録をすべて削除し、`registerServerFn` を返す。 */
export function serverFnModule(fnModule: string): typeof registerServerFn {
  for (const id of registry.keys()) {
    if (moduleOfServerFnId(id) === fnModule) registry.delete(id);
  }
  return registerServerFn;
}

/**
 * サーバー関数のエンドポイントへのリクエストを処理し、それ以外のリクエストを後続の処理に渡す Hono のミドルウェアを返す。
 * rinka が扱わない例外は、リクエストの種類に対応する `failures` の関数が返すレスポンスにする。
 */
export function serverFnMiddleware(options: AppOptions, failures: Failures): MiddlewareHandler {
  return async (c, next) => {
    const kind = requestKind(c);
    if (kind === undefined) {
      await next();
      return undefined;
    }
    const responder = responders[kind];
    let id: string;
    try {
      id = decodeURIComponent(new URL(c.req.url).pathname.slice(rpcPrefix.length));
    } catch {
      return responder.reject(c, 404);
    }
    return endpoint(c, id, kind, options, failures[kind]);
  };
}

/**
 * サーバー関数のエンドポイントへのリクエスト `c` では、投げられた値 `error` から、サーバー関数が投げた値と同じレスポンスを作成する。
 * それ以外のリクエストでは `undefined` を返す。
 */
export function serverFnFailure(
  c: Context,
  error: unknown,
  failures: Failures,
): Response | Promise<Response> | undefined {
  const kind = requestKind(c);
  return kind === undefined ? undefined : respondThrown(c, kind, error, failures[kind]);
}

async function endpoint(
  c: Context,
  id: string,
  kind: RequestKind,
  options: AppOptions,
  fail: Failure,
): Promise<Response> {
  const responder = responders[kind];
  const definition = await find(id, options);
  if (!definition) return responder.reject(c, 404);
  const { method, middlewares, handle } = definition;
  const requested = handledMethod(c);
  if (requested !== method) return responder.reject(c, 405);
  if (method !== "GET" && isCrossSite(c.req.raw, options.trustedOrigins ?? [])) {
    return responder.reject(c, 403);
  }
  let input: unknown;
  try {
    input = await responder.read(c);
  } catch {
    return responder.reject(c, 400);
  }
  const opened: { relay?: Relay; body?: ReadableStream | null } = {};
  const response = await runChain(
    c,
    middlewares,
    async () => {
      const value = await handle(c, input);
      if (value instanceof Response) return value;
      if (!isAsyncIterable(value)) return responder.respond(c, { kind: "value", value }, fail);
      const relay = new Relay(value);
      opened.relay = relay;
      const streamed = await responder.respond(
        c,
        { kind: "stream", relay, first: await relay.first },
        fail,
      );
      opened.body = streamed.body;
      return streamed;
    },
    (error) => respondThrown(c, kind, error, fail),
  );
  // ミドルウェアがストリームの本文を使わないレスポンスに置換したら、本文から反復を終えられないので、ここで終える
  const { relay, body } = opened;
  if (relay && response.body !== body) await relay.close();
  return response;
}

/** リクエストの種類が `kind` のリクエスト `c` で投げられた値 `error` から、レスポンスを作成する。`redirect()` は、リクエストの種類にかかわらず 303 にする。 */
function respondThrown(
  c: Context,
  kind: RequestKind,
  error: unknown,
  fail: Failure,
): Response | Promise<Response> {
  const { respond, reject } = responders[kind];
  const thrown = classify(error);
  switch (thrown.kind) {
    case "redirect":
      return c.redirect(thrown.location, 303);
    case "moved":
    case "response":
      return thrown.response;
    case "notFound":
      return reject(c, 404);
    case "schema":
      return respond(c, thrown, fail);
    case "error":
      return respond(c, { kind: "error", error }, fail);
  }
}

/** handler の戻り値と、handler が投げた値のうち、レスポンスの形をリクエストの種類ごとの `respond` で決めるものを表す。 */
type Outcome =
  | { readonly kind: "value"; readonly value: unknown }
  | Streamed
  | { readonly kind: "schema"; readonly issues: SchemaError["issues"] }
  | { readonly kind: "error"; readonly error: unknown };

/** handler が返した async iterable の Relay と、その最初の `next()` の結果を表す。 */
interface Streamed {
  readonly kind: "stream";
  readonly relay: Relay;
  readonly first: IteratorResult<unknown>;
}

/** handler の結果の分類の名前である。 */
export type OutcomeKind = Outcome["kind"];

/** サーバー関数のエンドポイントへのリクエストの種類である。`form` はフォームの送信で、`rpc` はそれ以外である。 */
type RequestKind = "rpc" | "form";

/** サーバー関数が投げた、rinka が扱わない例外から、リクエスト `c` のレスポンスを作成する。 */
export type Failure = (c: Context, error: unknown) => Response | Promise<Response>;

/** リクエストの種類ごとの `Failure` である。 */
export type Failures = Readonly<Record<RequestKind, Failure>>;

/** rinka がリクエストを拒否するときのステータスである。 */
type Rejection = 400 | 403 | 404 | 405;

/** リクエストの種類ごとの、入力の読み方とレスポンスの作り方である。 */
interface Responder {
  /** リクエストから入力を読む。読めなければ例外を投げる。 */
  readonly read: (c: Context) => Promise<unknown>;
  /** リクエストを拒否するレスポンスを返す。 */
  readonly reject: (c: Context, status: Rejection) => Response;
  /** handler の結果のレスポンスを返す。 */
  readonly respond: (c: Context, outcome: Outcome, fail: Failure) => Response | Promise<Response>;
}

const rejectionText = {
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
} satisfies Record<Rejection, string>;

const responders = {
  rpc: {
    read: readInput,
    reject: (c, status) => rpc(c, null, status),
    respond: (c, outcome, fail) => {
      switch (outcome.kind) {
        case "value":
          return rpc(c, toRpcBody(outcome.value));
        case "stream":
          return stream(c, outcome, fail);
        case "schema":
          return rpc(c, { issues: outcome.issues }, 422);
        case "error":
          return fail(c, outcome.error);
      }
    },
  },
  form: {
    read: async (c) => formDataToInput(await c.req.formData()),
    reject: (c, status) => c.text(rejectionText[status], status),
    respond: async (c, outcome, fail) => {
      switch (outcome.kind) {
        case "stream":
          for await (const _ of outcome.relay.rest());
          return c.redirect(callerOf(c)?.page?.href ?? c.req.header("referer") ?? "/", 303);
        case "value":
          return c.redirect(callerOf(c)?.page?.href ?? c.req.header("referer") ?? "/", 303);
        case "schema":
          return c.json({ issues: outcome.issues }, 422);
        case "error":
          return fail(c, outcome.error);
      }
    },
  },
} satisfies Record<RequestKind, Responder>;

/** サブリクエスト `request` を、リクエスト `c` と同じアプリで処理したレスポンスを返す関数を表す。 */
export type FetchPage = (c: Context, request: Request) => Response | Promise<Response>;

/**
 * JS から呼び出したサーバー関数のレスポンスを、クライアントが反映する形にする Hono のミドルウェアを返す。対象は、`callerOf` が呼び出し元を返すリクエストである。
 * 3xx で安全な `Location` を持つレスポンスは、`Location` の値を持つ `{ redirect }` の 200 の JSON に置換し、移動先（相対 URL は呼び出し元のページの URL のオリジンで解決する）が hash を除いて呼び出し元のページと一致するときは、そのページの描き直しを含める。
 * それ以外のレスポンスは、呼び出し元のページがあり、`x-rinka-wire: rpc` を持つ 2xx で、本文がオブジェクトの JSON のときに、ステータスを保って描き直しを含める。
 * 呼び出し元のページがあり、`x-rinka-wire: stream` を持つ 2xx のレスポンスは、`withPageAtEnd` で終わりの行に描き直しを含める。
 * 描き直しは `fetchPage` で作成し、描き直しの JSON を `page` に含める。描き直しのレスポンスが JSON として読めなければ、`page` を含めない。
 * 描き直しのサブリクエストの `Cookie` は、サーバー関数のレスポンスの `Set-Cookie` を反映した値にし、描き直しのレスポンスの `Set-Cookie` はレスポンスに追加する。
 */
export function callerResponses(fetchPage: FetchPage): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const caller = callerOf(c);
    if (caller === undefined) return;
    const { page } = caller;
    const location = c.res.headers.get("location");
    if (
      location !== null &&
      c.res.status >= 300 &&
      c.res.status < 400 &&
      isSafeLocation(location)
    ) {
      const body = { redirect: location } satisfies RedirectJson;
      const same = page !== undefined && sameDocument(locationOf(location, c, page), page);
      await replaceWithPage(c, body, same ? page : undefined, fetchPage, 200);
      return;
    }
    if (page === undefined || !c.res.ok) return;
    if (c.res.headers.get(wireHeader) === wireFormat.stream) {
      replaceResponse(c, withPageAtEnd(c, c.res, page, fetchPage));
      return;
    }
    if (c.res.headers.get(wireHeader) !== wireFormat.rpc) return;
    const body: unknown = await c.res
      .clone()
      .json()
      .catch(() => undefined);
    if (isPlainObject(body)) await replaceWithPage(c, body, page, fetchPage, c.res.status);
  };
}

/**
 * `c` のレスポンスを、ステータスが `status` の `body` の JSON に置換する。
 * `page` があれば、`fetchPage` でそのページを描き直し、描き直しの JSON を `page` に含め、描き直しのレスポンスの `Set-Cookie` を追加する。
 */
async function replaceWithPage(
  c: Context,
  body: object,
  page: URL | undefined,
  fetchPage: FetchPage,
  status: number,
): Promise<void> {
  const { response, refreshed } =
    page === undefined
      ? { response: undefined, refreshed: undefined }
      : await refreshedPage(c, page, fetchPage);
  const headers = new Headers(c.res.headers);
  if (response === undefined || refreshed === undefined) {
    replaceJson(c, body, headers, status);
    return;
  }
  for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
  replaceJson(c, { ...body, page: refreshed }, headers, status);
}

/** `fetchPage` でページ `page` を描き直したレスポンスと、その本文の描き直しの JSON を返す。レスポンスが JSON でないときと、本文を JSON として解析できないときは、`refreshed` は `undefined` である。 */
async function refreshedPage(
  c: Context,
  page: URL,
  fetchPage: FetchPage,
): Promise<{ response: Response; refreshed: unknown }> {
  const response = await fetchPage(c, pageRequest(c, page, true));
  const json = response.headers.get("content-type")?.startsWith("application/json") ?? false;
  return { response, refreshed: json ? await response.json().catch(() => undefined) : undefined };
}

/**
 * ストリームのレスポンス `response` の行を、そのまま送信するレスポンスを返す。
 * `{ end: true }` の行と、移動先（相対 URL は `page` のオリジンで解決する）が hash を除いて `page` と一致する移動先の行には、
 * `fetchPage` で描き直したページの JSON を `page` に含める。描き直しのレスポンスの `Set-Cookie` は送信しない。
 */
function withPageAtEnd(c: Context, response: Response, page: URL, fetchPage: FetchPage): Response {
  const terminal = async (text: string): Promise<string> => {
    if (!isEndOrRedirectLineText(text)) return text;
    const line: unknown = JSON.parse(text);
    if (!isPlainObject(line)) return text;
    if (isRedirectJson(line) && !sameDocument(locationOf(line.redirect, c, page), page))
      return text;
    const { refreshed } = await refreshedPage(c, page, fetchPage);
    return refreshed === undefined ? text : JSON.stringify({ ...line, page: refreshed });
  };
  const body = response.body
    ?.pipeThrough(new TextDecoderStream())
    .pipeThrough(splitLines())
    .pipeThrough(
      new TransformStream<string, string>({
        transform: async (line, controller) => {
          controller.enqueue(`${await terminal(line)}\n`);
        },
      }),
    )
    .pipeThrough(new TextEncoderStream());
  return new Response(body, response);
}

/** JS からサーバー関数を呼び出したリクエストの呼び出し元を表す。`page` は、描き直す呼び出し元のページの URL である。 */
export interface Caller {
  readonly page: URL | undefined;
}

/**
 * リクエスト `c` が JS からのサーバー関数の呼び出し（RPC と、`x-rinka-page` を持つフォームの送信）なら、その呼び出し元を返す。それ以外のリクエストでは `undefined` を返す。
 * `page` は、GET 以外のリクエストで、`x-rinka-page` の URL のホストがリクエストの URL と同じで、パスが `/_rinka/` の下にないときに、その URL を持つ。
 */
export function callerOf(c: Context): Caller | undefined {
  const kind = requestKind(c);
  const value = c.req.header(PAGE_HEADER);
  if (kind === undefined || (kind === "form" && value === undefined)) return undefined;
  return { page: handledMethod(c) === "GET" ? undefined : localPageOf(value, c) };
}

/** `value` が、ホストがリクエスト `c` の URL と同じで、パスが `/_rinka/` の下にない URL なら、その URL を返す。 */
function localPageOf(value: string | undefined, c: Context): URL | undefined {
  if (value === undefined || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.host === new URL(c.req.url).host && !url.pathname.startsWith(internalPrefix)
    ? url
    : undefined;
}

/**
 * フォームの送信 `c` が JS からの送信かどうかを `js` に、送信したページの URL を `page` に返す。JS があるときは `x-rinka-page` の URL を、JS が無いときは Referer の URL を使用する。
 * URL が無いとき、そのホストがリクエストのホストと異なるとき、そのパスが `/_rinka/` の下にあるときは、`page` を `undefined` にする。
 */
export function submittedPage(c: Context): {
  readonly js: boolean;
  readonly page: URL | undefined;
} {
  const caller = callerOf(c);
  if (caller !== undefined) return { js: true, page: caller.page };
  return { js: false, page: localPageOf(c.req.header("referer"), c) };
}

/** リクエスト `c` のレスポンスの移動先 `location` を、`c` の URL のパスとクエリと、ページ `page` の URL のオリジンを基準に解決する。 */
function locationOf(location: string, c: Context, page: URL): URL {
  const { pathname, search } = new URL(c.req.url);
  return new URL(location, new URL(`${pathname}${search}`, page.origin));
}

/**
 * リクエスト `c` のヘッダーを引き継いで、ページ `page` を取得する GET のリクエストを返す。`refresh` が真なら、描き直しの JSON を要求する。
 * 本文、圧縮、条件付きのリクエストのヘッダーと `x-rinka-page` は除外し、`Cookie` は、`c` のレスポンスの `Set-Cookie` を反映した値にする。
 */
export function pageRequest(c: Context, page: URL, refresh: boolean): Request {
  const headers = new Headers(c.req.raw.headers);
  for (const name of [
    "content-type",
    "content-length",
    "accept-encoding",
    "if-none-match",
    "if-modified-since",
    wireHeader,
    PAGE_HEADER,
    REFRESH_HEADER,
  ]) {
    headers.delete(name);
  }
  if (refresh) headers.set(REFRESH_HEADER, "1");
  const cookie = cookieAfter(c.req.header("cookie"), c.res.headers.getSetCookie());
  if (cookie === "") headers.delete("cookie");
  else headers.set("cookie", cookie);
  return new Request(new URL(`${page.pathname}${page.search}`, c.req.url), { headers });
}

/** `c` のレスポンスを、`from` のヘッダーを引き継いだ、ステータスが `status` の `body` の JSON に置換する。`Location` と `Content-Length` は引き継がず、`x-rinka-wire: rpc` を付与する。 */
function replaceJson(c: Context, body: object, from: Headers, status: number): void {
  const headers = new Headers(from);
  headers.delete("location");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set(wireHeader, wireFormat.rpc);
  replaceResponse(c, new Response(JSON.stringify(body), { status, headers }));
}

/** リクエスト `c` が、サーバー関数のエンドポイントへのリクエストなら、その種類を返す。それ以外のリクエストでは `undefined` を返す。 */
function requestKind(c: Context): RequestKind | undefined {
  if (!new URL(c.req.url).pathname.startsWith(rpcPrefix)) return undefined;
  return isFormSubmission(c) ? "form" : "rpc";
}

/** フォームの送信と同じ `Content-Type` の POST かどうかを返す。 */
function isFormSubmission(c: Context): boolean {
  if (c.req.method !== "POST") return false;
  const type = c.req.header("content-type")?.toLowerCase() ?? "";
  return (
    type.startsWith("multipart/form-data") || type.startsWith("application/x-www-form-urlencoded")
  );
}

/** ID が `id` のサーバー関数の定義を返す。`options.loadServerFn` があれば、それが真を返したときだけ検索する。 */
async function find(id: string, options: AppOptions): Promise<Definition | undefined> {
  if (options.loadServerFn && !(await options.loadServerFn(id))) return undefined;
  return registry.get(id);
}

/** リクエストから、サーバー関数の入力を読む。入力が無ければ `undefined` を返す。 */
async function readInput(c: Context): Promise<unknown> {
  if (c.req.method !== "POST") {
    const json = c.req.query(rpcQuery.json);
    if (json !== undefined) return parseJson(json);
    const serialized = c.req.query(rpcQuery.seroval);
    return serialized === undefined ? undefined : fromRpcInput(serialized);
  }
  const text = await c.req.text();
  if (text === "") return undefined;
  return c.req.header(wireHeader) === wireFormat.seroval ? fromRpcInput(text) : parseJson(text);
}

const parseJson = (text: string): unknown => JSON.parse(text);

/**
 * `first` と、`relay` がその後に返す値を、改行で区切った `StreamLine` の行で送信するレスポンスを返す。値の行の後に `{ end: true }` を送信する。
 * 最初の値は、レスポンスを作成する前にシリアライズし、シリアライズできなければ例外を投げる。
 * 2 番目以降の値で `redirect()` か、`isSafeLocation` が安全と判定する移動先の 3xx の Response を投げたら、移動先を伝える行を送信する。
 * それ以外の値を投げたときと、値をシリアライズできないときは、`{ error: true }` を送信する。投げた値が `notFound()`、`HTTPException`、Response でなければ、送信する前に `fail` に渡す。
 * 最後の行を送信したときと、本文の読み取りが中止されたときは、`relay` を閉じる。
 */
function stream(c: Context, { relay, first }: Streamed, fail: Failure): Response {
  const encoder = new TextEncoder();
  const encode = (line: StreamLine) => encoder.encode(`${streamLineText(line)}\n`);
  const failed = async (error: unknown): Promise<StreamLine> => {
    const thrown = classify(error);
    const location = navigableLocation(thrown);
    if (location !== undefined) return { redirect: location };
    if (thrown.kind === "error" || thrown.kind === "schema") {
      await runInRequest(c, () => fail(c, error));
    }
    return { error: true };
  };
  const firstLine: StreamLine = first.done === true ? { end: true } : toRpcBody(first.value);
  const lines = (async function* (): AsyncGenerator<StreamLine, void> {
    yield firstLine;
    if (first.done === true) return;
    try {
      for await (const value of relay.rest()) yield toRpcBody(value);
      yield { end: true };
    } catch (error) {
      yield await failed(error);
    }
  })();
  c.header(wireHeader, wireFormat.stream);
  c.header("content-type", "application/x-ndjson; charset=utf-8");
  return c.body(
    new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const result = await lines.next();
        if (result.done !== true) {
          controller.enqueue(encode(result.value));
          return;
        }
        controller.close();
        await relay.close();
      },
      cancel: () => relay.close(),
    }),
  );
}

/** `body` を JSON にし、`x-rinka-wire: rpc` を付けたレスポンスを返す。`status` が無ければ、`c.status` で設定したステータスにする。 */
function rpc(c: Context, body: unknown, status?: 200 | Rejection | 422): Response {
  c.header(wireHeader, wireFormat.rpc);
  if (status !== undefined) c.status(status);
  return body === null ? c.body(null) : c.json(body);
}

/**
 * 別のサイトから送られたリクエストかどうかを返す。`Origin` が `trustedOrigins` にあれば偽を返す。
 * `Sec-Fetch-Site` があれば、`same-origin` と `none` 以外を別のサイトとする。無ければ、`Origin` のホストがリクエストの URL のホストと異なるときに別のサイトとする。どちらも無ければ偽を返す。
 */
function isCrossSite(request: Request, trustedOrigins: readonly string[]): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && trustedOrigins.includes(origin)) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site !== "same-origin" && site !== "none";
  if (origin === null) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

/** ID のモジュールの部分ごとの、サーバー関数を定義したモジュールを読み込む関数から、ID のサーバー関数を読み込み、読み込んだら真を返す関数を作成する。 */
export function serverFnLoader(
  modules: Readonly<Record<string, () => Promise<unknown>>>,
): (id: string) => Promise<boolean> {
  return async (id) => {
    const fnModule = moduleOfServerFnId(id);
    if (fnModule === undefined || !Object.hasOwn(modules, fnModule)) return false;
    await modules[fnModule]!();
    return true;
  };
}

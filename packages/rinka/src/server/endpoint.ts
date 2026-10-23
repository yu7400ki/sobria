import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AppOptions } from "../shared/routes.ts";
import { serverFnRef, type ServerFnRef } from "../shared/server-fn.ts";
import { rpcPrefix, rpcQuery, wireFormat, wireHeader } from "../shared/wire.ts";
import { runInRequest } from "./context.ts";
import { NotFound, Redirect } from "./errors.ts";
import { formDataToInput } from "./form-data.ts";
import { runChain, SchemaError, serverFnKey, type ServerFn } from "./server-fn.ts";
import { fromRpcInput, toRpcBody } from "./wire.ts";

type AnyServerFn = Pick<ServerFn<never, unknown>, typeof serverFnKey>;

const registry = new Map<string, AnyServerFn>();

/** `fn` を、ID が `id` のサーバー関数として登録し、`fn` を返す。 */
export function registerServerFn<F extends AnyServerFn>(id: string, fn: F): F {
  registry.set(id, fn);
  const ref: ServerFnRef = { id, method: fn[serverFnKey].method };
  return Object.defineProperty(fn, serverFnRef, { value: ref });
}

/**
 * リクエストの Context を設定してから後続の処理を実行する、rinka の Hono のミドルウェアを返す。
 * サーバー関数のエンドポイントへのリクエストは、このミドルウェアが処理する。
 */
export function rinkaMiddleware(options: AppOptions): MiddlewareHandler {
  return (c, next) =>
    runInRequest(c, async () => {
      const { pathname } = new URL(c.req.url);
      if (!pathname.startsWith(rpcPrefix)) {
        await next();
        return undefined;
      }
      let id: string;
      try {
        id = decodeURIComponent(pathname.slice(rpcPrefix.length));
      } catch {
        return rpc(c, null, 404);
      }
      return endpoint(c, id, options);
    });
}

async function endpoint(c: Context, id: string, options: AppOptions): Promise<Response> {
  const fn = await find(id, options);
  if (!fn) return rpc(c, null, 404);
  const { method, middlewares, handle } = fn[serverFnKey];
  const requested = c.req.method === "HEAD" ? "GET" : c.req.method;
  if (requested !== method) return rpc(c, null, 405);
  if (method !== "GET" && isCrossSite(c.req.raw, options.trustedOrigins ?? [])) {
    return rpc(c, null, 403);
  }
  const form = isFormSubmission(c);
  let input: unknown;
  try {
    input = form ? formDataToInput(await c.req.formData()) : await readInput(c);
  } catch {
    return rpc(c, null, 400);
  }
  await runChain(
    c,
    middlewares,
    async () => {
      const value = await handle(c, input);
      if (value instanceof Response) return value;
      return form ? c.redirect(c.req.header("referer") ?? "/", 303) : rpc(c, toRpcBody(value));
    },
    (error) => (form ? formError(c, error) : rpcError(c, error)),
  );
  if (!c.finalized) throw new Error("ミドルウェアは、next() を呼ぶか、Response を返してください。");
  return c.res;
}

/** サーバー関数が投げた値を、RPC のレスポンスにする。rinka が扱わない値は投げ直す。 */
function rpcError(c: Context, error: unknown): Response {
  if (error instanceof Redirect) return rpc(c, { redirect: error.location }, 200);
  if (error instanceof NotFound) return rpc(c, null, 404);
  if (error instanceof SchemaError) return rpc(c, { issues: error.issues }, 422);
  if (error instanceof HTTPException) return httpResponse(c, error);
  throw error;
}

/** フォームの送信で、サーバー関数が投げた値をレスポンスにする。rinka が扱わない値は、素のテキストの 500 にする。 */
function formError(c: Context, error: unknown): Response {
  if (error instanceof Redirect) return c.redirect(error.location, 303);
  if (error instanceof NotFound) return c.text("Not Found", 404);
  if (error instanceof SchemaError) return c.json({ issues: error.issues }, 422);
  if (error instanceof HTTPException) return httpResponse(c, error);
  console.error(error);
  return c.text("Internal Server Error", 500);
}

/** `HTTPException` のレスポンスに、Context で設定したヘッダーを加えて返す。 */
function httpResponse(c: Context, error: HTTPException): Response {
  const response = error.getResponse();
  return c.newResponse(response.body, response);
}

/** フォームの送信と同じ `Content-Type` の POST かどうかを返す。 */
function isFormSubmission(c: Context): boolean {
  if (c.req.method !== "POST") return false;
  const type = c.req.header("content-type")?.toLowerCase() ?? "";
  return (
    type.startsWith("multipart/form-data") || type.startsWith("application/x-www-form-urlencoded")
  );
}

/** ID が `id` のサーバー関数を返す。`options.loadModule` があれば、ID のモジュールの部分を読み込んでから検索する。 */
async function find(id: string, options: AppOptions): Promise<AnyServerFn | undefined> {
  const separator = id.lastIndexOf("#");
  if (options.loadModule && separator !== -1) await options.loadModule(id.slice(0, separator));
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

/** `body` を JSON にし、`x-rinka-wire: rpc` を付けたレスポンスを返す。`status` が無ければ、`c.status` で設定したステータスにする。 */
function rpc(c: Context, body: unknown, status?: 200 | 400 | 403 | 404 | 405 | 422): Response {
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

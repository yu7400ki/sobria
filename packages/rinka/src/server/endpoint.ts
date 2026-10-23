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
      const responder = responders[isFormSubmission(c) ? "form" : "rpc"];
      let id: string;
      try {
        id = decodeURIComponent(pathname.slice(rpcPrefix.length));
      } catch {
        return responder.reject(c, 404);
      }
      return endpoint(c, id, responder, options);
    });
}

async function endpoint(
  c: Context,
  id: string,
  responder: Responder,
  options: AppOptions,
): Promise<Response> {
  const fn = await find(id, options);
  if (!fn) return responder.reject(c, 404);
  const { method, middlewares, handle } = fn[serverFnKey];
  const requested = c.req.method === "HEAD" ? "GET" : c.req.method;
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
  await runChain(
    c,
    middlewares,
    async () => {
      const value = await handle(c, input);
      return value instanceof Response ? value : responder.respond(c, { kind: "value", value });
    },
    (error) =>
      error instanceof HTTPException
        ? httpResponse(c, error)
        : responder.respond(c, outcomeOf(error)),
  );
  return c.res;
}

/** handler の戻り値と、handler が投げた値のうち、レスポンスの形をリクエストの種類で決めるものを表す。 */
type Outcome =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "notFound" }
  | { readonly kind: "schema"; readonly issues: SchemaError["issues"] };

/** `redirect()`、`notFound()`、スキーマの失敗を分類する。それ以外の値は投げ直す。 */
function outcomeOf(error: unknown): Outcome {
  if (error instanceof Redirect) return { kind: "redirect", location: error.location };
  if (error instanceof NotFound) return { kind: "notFound" };
  if (error instanceof SchemaError) return { kind: "schema", issues: error.issues };
  throw error;
}

/** rinka が handler を呼ばずに拒否するときのステータスである。 */
type Rejection = 400 | 403 | 404 | 405;

/** リクエストの種類ごとの、入力の読み方とレスポンスの作り方である。 */
interface Responder {
  /** リクエストから入力を読む。読めなければ例外を投げる。 */
  readonly read: (c: Context) => Promise<unknown>;
  /** handler を呼ばずに拒否するときのレスポンスを返す。 */
  readonly reject: (c: Context, status: Rejection) => Response;
  /** handler の結果のレスポンスを返す。 */
  readonly respond: (c: Context, outcome: Outcome) => Response;
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
    respond: (c, outcome) => {
      switch (outcome.kind) {
        case "value":
          return rpc(c, toRpcBody(outcome.value));
        case "redirect":
          return rpc(c, { redirect: outcome.location }, 200);
        case "notFound":
          return rpc(c, null, 404);
        case "schema":
          return rpc(c, { issues: outcome.issues }, 422);
        default:
          return unreachable(outcome);
      }
    },
  },
  form: {
    read: async (c) => formDataToInput(await c.req.formData()),
    reject: (c, status) => c.text(rejectionText[status], status),
    respond: (c, outcome) => {
      switch (outcome.kind) {
        case "value":
          return c.redirect(c.req.header("referer") ?? "/", 303);
        case "redirect":
          return c.redirect(outcome.location, 303);
        case "notFound":
          return c.text(rejectionText[404], 404);
        case "schema":
          return c.json({ issues: outcome.issues }, 422);
        default:
          return unreachable(outcome);
      }
    },
  },
} satisfies Record<"rpc" | "form", Responder>;

/** 型の上で到達しない値を受け取り、エラーを投げる。 */
function unreachable(value: never): never {
  throw new Error(`想定していない値です: ${JSON.stringify(value)}`);
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

/** ID が `id` のサーバー関数を返す。`options.loadServerFn` があれば、それが真を返したときだけ検索する。 */
async function find(id: string, options: AppOptions): Promise<AnyServerFn | undefined> {
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

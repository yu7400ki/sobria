import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AppOptions } from "../shared/routes.ts";
import { withServerFnRef, type serverFnRef, type ServerFnRef } from "../shared/server-fn.ts";
import { rpcPrefix, rpcQuery, wireFormat, wireHeader } from "../shared/wire.ts";
import { NotFound, Redirect } from "./errors.ts";
import { formDataToInput } from "./form-data.ts";
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

/**
 * サーバー関数のエンドポイントへのリクエストを処理し、それ以外のリクエストを後続の処理に渡す Hono のミドルウェアを返す。
 * rinka が扱わない例外は、`fail` が返すレスポンスにする。
 */
export function serverFnMiddleware(options: AppOptions, fail: Failure): MiddlewareHandler {
  return async (c, next) => {
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
    return endpoint(c, id, responder, options, fail);
  };
}

async function endpoint(
  c: Context,
  id: string,
  responder: Responder,
  options: AppOptions,
  fail: Failure,
): Promise<Response> {
  const definition = await find(id, options);
  if (!definition) return responder.reject(c, 404);
  const { method, middlewares, handle } = definition;
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
  return runChain(
    c,
    middlewares,
    async () => {
      const value = await handle(c, input);
      return value instanceof Response
        ? value
        : responder.respond(c, { kind: "value", value }, fail);
    },
    (error) => {
      if (error instanceof Response) return withContextHeaders(c, error);
      if (error instanceof HTTPException) return withContextHeaders(c, error.getResponse());
      return responder.respond(c, outcomeOf(error), fail);
    },
  );
}

/** handler の戻り値と、handler が投げた値のうち、レスポンスの形をリクエストの種類で決めるものを表す。 */
type Outcome =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "notFound" }
  | { readonly kind: "schema"; readonly issues: SchemaError["issues"] }
  | { readonly kind: "error"; readonly error: unknown };

/** handler の結果の分類の名前である。 */
export type OutcomeKind = Outcome["kind"];

/** handler が投げた値を分類する。`redirect()`、`notFound()`、スキーマの失敗以外の値は `error` にする。 */
function outcomeOf(error: unknown): Outcome {
  if (error instanceof Redirect) return { kind: "redirect", location: error.location };
  if (error instanceof NotFound) return { kind: "notFound" };
  if (error instanceof SchemaError) return { kind: "schema", issues: error.issues };
  return { kind: "error", error };
}

/** rinka が扱わない例外から、レスポンスを作成する。 */
export type Failure = (error: unknown, c: Context) => Response | Promise<Response>;

/** rinka が handler を呼ばずに拒否するときのステータスである。 */
type Rejection = 400 | 403 | 404 | 405;

/** リクエストの種類ごとの、入力の読み方とレスポンスの作り方である。 */
interface Responder {
  /** リクエストから入力を読む。読めなければ例外を投げる。 */
  readonly read: (c: Context) => Promise<unknown>;
  /** handler を呼ばずに拒否するときのレスポンスを返す。 */
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
        case "redirect":
          return rpc(c, { redirect: outcome.location }, 200);
        case "notFound":
          return rpc(c, null, 404);
        case "schema":
          return rpc(c, { issues: outcome.issues }, 422);
        case "error":
          return fail(outcome.error, c);
        default:
          return unreachable(outcome);
      }
    },
  },
  form: {
    read: async (c) => formDataToInput(await c.req.formData()),
    reject: (c, status) => c.text(rejectionText[status], status),
    respond: (c, outcome, fail) => {
      switch (outcome.kind) {
        case "value":
          return c.redirect(c.req.header("referer") ?? "/", 303);
        case "redirect":
          return c.redirect(outcome.location, 303);
        case "notFound":
          return c.text(rejectionText[404], 404);
        case "schema":
          return c.json({ issues: outcome.issues }, 422);
        case "error":
          return fail(outcome.error, c);
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

/**
 * `response` に、Context で設定したヘッダーを加えて返す。
 * `Set-Cookie` は、Context で設定したものを順に並べ、`response` のうち Context で設定していないものを後に加える。
 */
export function withContextHeaders(c: Pick<Context, "newResponse">, response: Response): Response {
  const pending = c.newResponse(null).headers.getSetCookie();
  const added = response.headers.getSetCookie().filter((cookie) => {
    const index = pending.indexOf(cookie);
    if (index === -1) return true;
    pending.splice(index, 1);
    return false;
  });
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  const init = new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  const merged = c.newResponse(response.body, init);
  for (const cookie of added) merged.headers.append("set-cookie", cookie);
  return merged;
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

import type { Context, MiddlewareHandler } from "hono";
import type { StandardSchema } from "hono/factory";
import type { IntersectNonAnyTypes } from "hono/types";

import { currentContext } from "./context.ts";

type AnyMiddleware = MiddlewareHandler<any, any, any>;

type MiddlewareEnvs<M extends AnyMiddleware[]> = {
  [K in keyof M]: M[K] extends MiddlewareHandler<infer E, any, any> ? E : never;
};

type AnySchema = StandardSchema<any, any>;

type ValidateFn = (value: any, c: Context) => unknown;

/** サーバー関数の入力を検証する Standard Schema か関数である。 */
export type Validation = AnySchema | ValidateFn;

type InputOf<V> = [V] extends [never]
  ? undefined
  : V extends AnySchema
    ? "types" extends keyof V["~standard"]
      ? NonNullable<V["~standard"]["types"]>["input"]
      : OutputOf<V>
    : V extends (value: infer I, c: Context) => unknown
      ? I
      : never;

type OutputOf<V> = [V] extends [never]
  ? undefined
  : V extends StandardSchema<any, infer O>
    ? O
    : V extends (...args: never[]) => infer O
      ? Awaited<O>
      : never;

/** サーバー関数を呼び出す HTTP のメソッドである。 */
export type ServerFnMethod = "GET" | "POST";

/** `defineServerFn` の 1 段目に指定するオプションである。 */
export interface ServerFnOptions<V extends Validation> {
  /** デフォルトは `"POST"` である。 */
  method?: ServerFnMethod;
  /** 入力を検証する。検証を通過した値が、handler の `input` になる。 */
  input?: V;
}

/** クライアントからサーバー関数を呼び出すときのオプションである。 */
export interface CallOptions {
  /** 中止すると、リクエストを中止する。 */
  signal?: AbortSignal;
  /** リクエストに付与するヘッダーである。 */
  headers?: HeadersInit;
}

type ServerFnHandler<M extends AnyMiddleware[], In, R> = (
  c: Context<IntersectNonAnyTypes<MiddlewareEnvs<M>>>,
  args: { input: In },
) => R;

/** 入力の型が `undefined` なら、入力を省略して呼び出せる。 */
export type ServerFn<In, R> = ([In] extends [undefined]
  ? (input?: In, options?: CallOptions) => Promise<Awaited<R>>
  : (input: In, options?: CallOptions) => Promise<Awaited<R>>) & {
  readonly [serverFnKey]: Definition;
};

export const serverFnKey: unique symbol = Symbol("rinka.serverFn");

interface Definition {
  method: ServerFnMethod;
  /** 引数の Context を使用してサーバー関数を実行し、handler の戻り値を返す。 */
  run: (c: Context, input: unknown) => Promise<unknown>;
}

/** Standard Schema の検証が失敗したことを表すエラーである。 */
export class SchemaError extends Error {
  readonly issues: StandardSchemaIssues;

  constructor(issues: StandardSchemaIssues) {
    super("入力の検証に失敗しました。");
    this.issues = issues;
  }
}

type StandardSchemaIssues = Extract<
  Awaited<ReturnType<StandardSchema["~standard"]["validate"]>>,
  { issues: unknown }
>["issues"];

/**
 * 1 段目のオプションを受け取り、ミドルウェアと handler からサーバー関数を作成する関数を返す。
 * サーバーで呼び出すと、処理中のリクエストの Context を使用して、ミドルウェア、入力の検証、handler の順に実行する。
 * ミドルウェアが `next()` を呼ばずに Response を返したら、その Response を投げる。
 * Standard Schema の検証が失敗したら、`issues` を持つ `SchemaError` を投げる。
 */
export function defineServerFn<V extends Validation = never>(
  options: ServerFnOptions<V>,
): <M extends AnyMiddleware[], R>(
  ...args: [...middleware: M, handler: ServerFnHandler<M, OutputOf<V>, R>]
) => ServerFn<InputOf<V>, R>;
/** オプションを省略して、ミドルウェアと handler からサーバー関数を作成する。 */
export function defineServerFn<M extends AnyMiddleware[], R>(
  ...args: [...middleware: M, handler: ServerFnHandler<M, undefined, R>]
): ServerFn<undefined, R>;
export function defineServerFn(...args: (ServerFnOptions<Validation> | Step)[]): unknown {
  const [first] = args;
  if (typeof first === "object") return (...steps: Step[]) => create(first, steps);
  return create(
    {},
    args.filter((arg) => typeof arg === "function"),
  );
}

/** ミドルウェアか handler である。どちらも Context と、`next` か `{ input }` を引数にする。 */
type Step = (c: Context, arg: any) => unknown;

function create(options: ServerFnOptions<Validation>, steps: Step[]): unknown {
  const middlewares = steps.slice(0, -1);
  const handler = steps.at(-1);
  if (handler === undefined) throw new TypeError("defineServerFn には handler を渡してください。");
  const definition: Definition = {
    method: options.method ?? "POST",
    run: (c, input) =>
      runChain(c, middlewares, async () =>
        handler(c, { input: await validate(options.input, input, c) }),
      ),
  };
  const fn = (input?: unknown) => definition.run(currentContext(), input);
  return Object.assign(fn, { [serverFnKey]: definition });
}

async function validate(
  validation: Validation | undefined,
  value: unknown,
  c: Context,
): Promise<unknown> {
  if (validation === undefined) return value;
  if ("~standard" in validation) {
    const result = await validation["~standard"].validate(value);
    if (result.issues) throw new SchemaError(result.issues);
    return result.value;
  }
  return validation(value, c);
}

async function runChain(
  c: Context,
  middlewares: Step[],
  last: () => Promise<unknown>,
): Promise<unknown> {
  let called = -1;
  let result: unknown;
  const dispatch = async (index: number): Promise<void> => {
    if (index <= called) throw new Error("ミドルウェアは、next() を 1 回だけ呼んでください。");
    called = index;
    const middleware = middlewares[index];
    if (middleware === undefined) {
      result = await last();
      return;
    }
    let settled: { ok: true } | { ok: false; error: unknown } | undefined;
    const next = async () => {
      try {
        await dispatch(index + 1);
        settled = { ok: true };
      } catch (error) {
        settled = { ok: false, error };
        throw error;
      }
    };
    const returned = await middleware(c, next);
    if (settled?.ok) return;
    // oxlint-disable-next-line typescript/only-throw-error
    if (returned instanceof Response) throw returned;
    if (settled) throw settled.error;
    throw new Error("ミドルウェアは、next() を呼ぶか、Response を返してください。");
  };
  await dispatch(0);
  return result;
}

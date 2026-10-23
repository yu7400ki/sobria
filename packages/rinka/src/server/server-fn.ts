import { Context, type MiddlewareHandler } from "hono";
import type { StandardSchema } from "hono/factory";
import type { IntersectNonAnyTypes } from "hono/types";

import {
  defaultServerFnMethod,
  type CallOptions,
  type serverFnRef,
  type ServerFnMethod,
  type ServerFnRef,
} from "../shared/server-fn.ts";
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

/** `defineServerFn` の 1 段目に指定するオプションである。 */
export interface ServerFnOptions<V extends Validation, M extends ServerFnMethod = ServerFnMethod> {
  /** デフォルトは `"POST"` である。 */
  method?: M;
  /** 入力を検証する。検証を通過した値が、handler の `input` になる。 */
  input?: V;
}

type ServerFnHandler<M extends AnyMiddleware[], In, R> = (
  c: Context<IntersectNonAnyTypes<MiddlewareEnvs<M>>>,
  args: { input: In },
) => R;

/** 入力の型が `undefined` なら、入力を省略して呼び出せる。 */
export type ServerFn<In, R, M extends ServerFnMethod = ServerFnMethod> = ([In] extends [undefined]
  ? (input?: In, options?: CallOptions) => Promise<Awaited<R>>
  : (input: In, options?: CallOptions) => Promise<Awaited<R>>) & {
  readonly [serverFnRef]: ServerFnRef<M>;
};

/** `defineServerFn` が作成した関数ごとの定義である。 */
const definitions = new WeakMap<object, Definition>();

/** `fn` が `defineServerFn` で作成した関数なら、その定義を返す。 */
export const definitionOf = (fn: object): Definition | undefined => definitions.get(fn);

/** サーバー関数の定義を表す。 */
export interface Definition {
  readonly method: ServerFnMethod;
  readonly middlewares: readonly Step[];
  /** 入力を検証し、検証を通過した値で handler を呼び、handler の戻り値を返す。 */
  readonly handle: (c: Context, input: unknown) => Promise<unknown>;
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
export function defineServerFn<
  V extends Validation = never,
  Method extends ServerFnMethod = typeof defaultServerFnMethod,
>(
  options: ServerFnOptions<V, Method>,
): <M extends AnyMiddleware[], R>(
  ...args: [...middleware: M, handler: ServerFnHandler<M, OutputOf<V>, R>]
) => ServerFn<InputOf<V>, R, Method>;
/** オプションを省略して、ミドルウェアと handler からサーバー関数を作成する。 */
export function defineServerFn<M extends AnyMiddleware[], R>(
  ...args: [...middleware: M, handler: ServerFnHandler<M, undefined, R>]
): ServerFn<undefined, R, typeof defaultServerFnMethod>;
export function defineServerFn(...args: (ServerFnOptions<Validation> | Step)[]): unknown {
  const [first] = args;
  if (typeof first === "object") return (...steps: Step[]) => create(first, steps);
  return create(
    {},
    args.filter((arg) => typeof arg === "function"),
  );
}

/** ミドルウェアか handler である。どちらも Context と、`next` か `{ input }` を引数にする。 */
export type Step = (c: Context, arg: any) => unknown;

function create(options: ServerFnOptions<Validation>, steps: Step[]): unknown {
  const middlewares = steps.slice(0, -1);
  const handler = steps.at(-1);
  if (handler === undefined) throw new TypeError("defineServerFn には handler を渡してください。");
  const definition: Definition = {
    method: options.method ?? defaultServerFnMethod,
    middlewares,
    handle: async (c, input) => handler(c, { input: await validate(options.input, input, c) }),
  };
  const fn = (input?: unknown) => callDirectly(currentContext(), definition, input);
  definitions.set(fn, definition);
  return fn;
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

/**
 * `page` のリクエストで、別の Context を使用してサーバー関数を実行し、handler の戻り値を返す。
 * 別の Context は `page` のリクエストと変数を受け継ぎ、ミドルウェアが `c.set` した変数は `page` に戻す。ミドルウェアが設定したレスポンスは `page` に反映しない。
 * handler が完了せずに、ミドルウェアがレスポンスを設定したら、そのレスポンスを投げる。
 */
async function callDirectly(
  page: Context,
  definition: Definition,
  input: unknown,
): Promise<unknown> {
  const c = scopedContext(page);
  try {
    const result = await runChain(c, definition.middlewares, () => definition.handle(c, input));
    // oxlint-disable-next-line typescript/only-throw-error
    if (!result.completed) throw result.response;
    return result.value;
  } finally {
    for (const [key, value] of Object.entries(c.var)) page.set(key, value);
  }
}

/** `page` のリクエスト、環境、変数を受け継いだ、新しい Context を返す。 */
function scopedContext(page: Context): Context {
  let executionCtx: Context["executionCtx"] | undefined;
  try {
    executionCtx = page.executionCtx;
  } catch {
    executionCtx = undefined;
  }
  const env: unknown = page.env;
  const c = new Context(page.req.raw, {
    env,
    ...(executionCtx !== undefined && { executionCtx }),
  });
  Object.defineProperty(c, "req", { value: page.req });
  for (const [key, value] of Object.entries(page.var)) c.set(key, value);
  return c;
}

/** `runChain` の結果である。`last` が完了したら、その戻り値を持つ。完了せずにレスポンスが確定したら、そのレスポンスを持つ。 */
type ChainResult =
  | { readonly completed: true; readonly value: unknown }
  | { readonly completed: false; readonly response: Response };

/**
 * Hono のミドルウェアの合成と同じ規則で、`middlewares` と `last` を順に実行する。
 * ミドルウェアか `last` が返した Response は、`c.res` が確定していなければ `c.res` にする。
 * `onError` があれば、投げられた値を `onError` が返す Response にして `c.res` にし、外側のミドルウェアの `next()` を正常に終了させる。
 * `last` が完了せず、レスポンスも確定しなければ、`last` が投げた値を投げる。`last` が呼ばれていなければ、エラーを投げる。
 */
export async function runChain(
  c: Context,
  middlewares: readonly Step[],
  last: () => Promise<unknown>,
  onError?: (error: unknown) => Response | Promise<Response>,
): Promise<ChainResult> {
  let called = -1;
  let completion: { readonly value: unknown } | undefined;
  let failure: { readonly error: unknown } | undefined;
  const runLast = async (): Promise<unknown> => {
    try {
      const value = await last();
      completion = { value };
      return value;
    } catch (error) {
      failure = { error };
      throw error;
    }
  };
  const dispatch = async (index: number): Promise<void> => {
    if (index <= called) throw new Error("ミドルウェアは、next() を 1 回だけ呼んでください。");
    called = index;
    const middleware = middlewares[index];
    let value: unknown;
    let failed = false;
    try {
      value = middleware ? await middleware(c, () => dispatch(index + 1)) : await runLast();
    } catch (error) {
      if (!onError) throw error;
      if (error instanceof Error) c.error = error;
      value = await onError(error);
      failed = true;
    }
    if (value instanceof Response && (!c.finalized || failed)) c.res = value;
  };
  await dispatch(0);
  if (completion) return { completed: true, value: completion.value };
  if (c.finalized) return { completed: false, response: c.res };
  if (failure) throw failure.error;
  throw new Error("ミドルウェアは、next() を呼ぶか、Response を返してください。");
}

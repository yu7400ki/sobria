import type { StandardSchema } from "hono/factory";
import { defineMiddleware, defineServerFn, getServerFnResult, type ServerFn } from "rinka/server";
import { expectTypeOf, test } from "vitest";

declare const numberFromString: StandardSchema<string, number>;
declare const coerceNumber: StandardSchema<unknown, number>;

/** File を含む入力をそのまま返す検証の関数である。 */
const withPhoto = (value: { photo: File }) => value;

/** Blob の配列を値に持つ Map を含む入力をそのまま返す検証の関数である。 */
const withPages = (value: { pages: Map<string, Blob[]> }) => value;

/** `~standard.types` を持たず、`validate()` が数を返す Standard Schema である。 */
const typeless = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value: Number(value) }),
  },
} as const;

test("呼び出しの引数は検証の入力の型、handler の input は検証の出力の型、戻り値は handler の戻り値の型である", () => {
  const fn = defineServerFn({ input: numberFromString })(async (_c, { input }) => {
    expectTypeOf(input).toEqualTypeOf<number>();
    return { doubled: input * 2 };
  });
  expectTypeOf(fn).parameter(0).toEqualTypeOf<string>();
  expectTypeOf(fn).returns.toEqualTypeOf<Promise<{ doubled: number }>>();
});

test("関数で検証すると、関数の引数の型が呼び出しの引数の型に、戻り値の型が handler の input の型になる", () => {
  const fn = defineServerFn({ input: (value: string) => Number(value) })((_c, { input }) => {
    expectTypeOf(input).toEqualTypeOf<number>();
    return input;
  });
  expectTypeOf(fn).parameter(0).toEqualTypeOf<string>();
  expectTypeOf(fn).returns.toEqualTypeOf<Promise<number>>();
});

test("1 段目を省略した関数は、入力を受け取らずに呼び出せる", () => {
  const ping = defineServerFn(() => "pong");
  expectTypeOf(ping()).toEqualTypeOf<Promise<string>>();
});

test("呼び出しの 2 つ目の引数で、signal と headers を指定できる", () => {
  const fn = defineServerFn({ method: "GET", input: numberFromString })((_c, { input }) => input);
  void fn("1", { signal: AbortSignal.timeout(1000), headers: { "x-a": "b" } });
  // @ts-expect-error 入力の型と異なる値は渡せない
  void fn(1);
});

test("GET のサーバー関数は、入力の型が File か Blob を含むと handler を渡せず、POST のサーバー関数は定義できる", () => {
  const photo = new File(["x"], "x.txt");
  // @ts-expect-error GET の入力に File を含められない
  defineServerFn({ method: "GET", input: withPhoto })(() => null);
  // @ts-expect-error GET の入力の Map の値の配列に Blob を含められない
  defineServerFn({ method: "GET", input: withPages })(() => null);
  const passThrough = defineMiddleware(async (_c, next) => {
    await next();
  });
  // @ts-expect-error ミドルウェアを渡しても、GET の入力に File を含められない
  defineServerFn({ method: "GET", input: withPhoto })(passThrough, () => null);
  const post = defineServerFn({ input: withPhoto })(() => null);
  void post({ photo });
  const plain = defineServerFn({ method: "GET", input: (value: { name: string }) => value })(
    () => null,
  );
  void plain({ name: "a" });
});

test("GET のサーバー関数を型引数の入力の型で受け取る関数から、入力を渡して呼び出せる", () => {
  expectTypeOf(<In>(fn: ServerFn<In, null, "GET">, input: In) => fn(input)).returns.toEqualTypeOf<
    Promise<null>
  >();
});

test("ミドルウェアが設定する変数は、handler の c.get で型が付き、設定されない変数は型エラーになる", () => {
  const auth = defineMiddleware<{ Variables: { session: { id: string } } }>(async (c, next) => {
    c.set("session", { id: "1" });
    await next();
  });
  const untyped = defineMiddleware(async (_c, next) => {
    await next();
  });
  defineServerFn(untyped, auth, (c) => {
    expectTypeOf(c.get("session")).toEqualTypeOf<{ id: string }>();
    // @ts-expect-error どのミドルウェアも設定しない変数
    c.get("other");
    return null;
  });
  defineServerFn({ input: numberFromString })(auth, (c, { input }) => c.get("session").id + input);
});

test("入力の型が unknown の Standard Schema では、呼び出しの引数の型は unknown である", () => {
  const fn = defineServerFn({ input: coerceNumber })((_c, { input }) => input);
  expectTypeOf(fn).parameter(0).toEqualTypeOf<unknown>();
  expectTypeOf(fn).returns.toEqualTypeOf<Promise<number>>();
});

test("型を持たない Standard Schema では、validate() が返す value の型を、呼び出しの引数と handler の input の型にする", () => {
  const fn = defineServerFn({ input: typeless })((_c, { input }) => {
    expectTypeOf(input).toEqualTypeOf<number>();
    return input;
  });
  expectTypeOf(fn).parameter(0).toEqualTypeOf<number>();
});

/** `T` が 2 つ以上の型の共用体なら `true` になる。 */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

test("サーバー関数の型が持つ symbol のキーは、ID とメソッドのキーの 1 つだけである", () => {
  const fn = defineServerFn(() => null);
  expectTypeOf<IsUnion<Extract<keyof typeof fn, symbol>>>().toEqualTypeOf<false>();
});

test("handler が async iterable を返すと、呼び出しは yield する値の async iterable に解決する", () => {
  const stream = defineServerFn(async function* () {
    for (const n of [1, 2]) yield n;
  });
  expectTypeOf(stream()).toEqualTypeOf<Promise<AsyncIterable<number>>>();
});

test("getServerFnResult は、サーバー関数の戻り値の型か undefined を返し、入力のあるサーバー関数も受け付ける", () => {
  const save = defineServerFn({ input: numberFromString })(() => ({ errors: ["e"] }));
  const reset = defineServerFn(() => "done");
  expectTypeOf(getServerFnResult(save)).toEqualTypeOf<{ errors: string[] } | undefined>();
  expectTypeOf(getServerFnResult(reset)).toEqualTypeOf<string | undefined>();
  const streamed = defineServerFn(async function* () {
    yield 1;
  });
  expectTypeOf(getServerFnResult(streamed)).toEqualTypeOf<undefined>();
  const branched = defineServerFn((c) =>
    c.req.query("x") === undefined ? { errors: ["e"] } : new Response(null),
  );
  expectTypeOf(getServerFnResult(branched)).toEqualTypeOf<{ errors: string[] } | undefined>();
  const mixed = defineServerFn((): { a: number } | AsyncIterable<number> => ({ a: 1 }));
  expectTypeOf(getServerFnResult(mixed)).toEqualTypeOf<{ a: number } | undefined>();
  // @ts-expect-error サーバー関数でない関数は受け付けない
  getServerFnResult(() => 1);
});

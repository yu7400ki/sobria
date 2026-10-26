import { action, memo, refresh, wait } from "rinka";
import { expectTypeOf, test } from "vitest";

test("action は async 関数を受け付けない", () => {
  // @ts-expect-error action が受け付けるのは generator 関数だけである
  action(async () => {});
  // @ts-expect-error action は async generator 関数を受け付けない
  action(async function* () {});
});

test("action の generator は Promise だけを yield できる", () => {
  const user = memo(async () => 1);
  // @ts-expect-error refresh を呼び出さずに yield すると、何も待たない
  action(function* () {
    yield refresh;
  });
  action(function* () {
    yield refresh(user);
  });
});

test("action が返す関数は、generator の引数を受け取り、generator の戻り値で解決する Promise を返す", () => {
  const save = action(function* (id: number) {
    yield Promise.resolve();
    return String(id);
  });
  expectTypeOf(save).parameters.toEqualTypeOf<[id: number]>();
  expectTypeOf(save).returns.toEqualTypeOf<Promise<string>>();
});

test("yield* wait(promise) の値は、promise の値の型になる", () => {
  action(function* () {
    const user = yield* wait(Promise.resolve({ name: "a" }));
    expectTypeOf(user).toEqualTypeOf<{ name: string }>();
  });
});

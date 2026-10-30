import { expectTypeOf, test } from "vitest";

import { action, memo, refresh, wait } from "../../../src/shared/signals.ts";

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

async function* numbers() {
  yield 1;
}

async function* letters() {
  yield "a";
}

test("memo の関数が async iterable を返すと、memo の値は iterable が yield する値の型になる", () => {
  expectTypeOf(memo(() => numbers())).returns.toEqualTypeOf<number>();
  expectTypeOf(memo(() => Promise.resolve(letters()))).returns.toEqualTypeOf<string>();
  expectTypeOf(memo(() => Promise.resolve(1))).returns.toEqualTypeOf<number>();
});

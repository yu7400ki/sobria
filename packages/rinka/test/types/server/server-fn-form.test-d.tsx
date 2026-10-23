import { defineServerFn } from "rinka/server";
import { test } from "vitest";

const save = defineServerFn(() => null);
const read = defineServerFn({ method: "GET" })(() => null);

test("form の action には POST のサーバー関数を渡せ、GET のサーバー関数は型エラーになる", () => {
  void (<form action={save} />);
  void (<form action="/plain" />);
  // @ts-expect-error GET のサーバー関数はフォームで送信できない
  void (<form action={read} />);
});

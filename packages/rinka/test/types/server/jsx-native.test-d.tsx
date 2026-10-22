import { test } from "vitest";

test("サーバーのファイルのネイティブのタグは、属性を受け付ける", () => {
  void (<label for="name" class="field" data-id={1} />);
  // @ts-expect-error 打ち間違えた属性は型エラーになる
  void (<label fro="name" />);
});

test("サーバーのファイルのネイティブのタグに、イベントハンドラーと ref を記述すると型エラーになる", () => {
  // @ts-expect-error イベントハンドラーは要素の中でだけ記述できる
  void (<button onClick={() => {}} />);
  // @ts-expect-error ref は要素の中でだけ記述できる
  void (<input ref={() => {}} />);
});

import { test } from "vitest";

test("共通のコンポーネントのネイティブのタグは、属性を受け付ける", () => {
  void (<label for="name" class="field" />);
});

test("共通のコンポーネントのネイティブのタグに、イベントハンドラーと ref を記述すると型エラーになる", () => {
  // @ts-expect-error イベントハンドラーは要素の中でだけ記述できる
  void (<button onClick={() => {}} />);
  // @ts-expect-error ref は要素の中でだけ記述できる
  void (<input ref={() => {}} />);
});

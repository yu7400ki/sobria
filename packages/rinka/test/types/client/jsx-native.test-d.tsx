import { expectTypeOf, test } from "vitest";

test("ネイティブのタグは、HTML の属性名で記述した、タグごとの属性を受け付ける", () => {
  void (<label for="name" class={{ active: true }} data-id={1} aria-label="名前" />);
  void (<input type="text" value={() => "v"} tabindex={0} />);
  void (<custom-widget anything={1} />);
  void (<circle r={1} />);
  // @ts-expect-error 打ち間違えた属性は型エラーになる
  void (<label fro="name" />);
  // @ts-expect-error 別のタグの属性は型エラーになる
  void (<label href="/" />);
});

test("要素の中のネイティブのタグは、イベントハンドラーと ref を受け付ける", () => {
  void (
    <button
      onClick={(event) => expectTypeOf(event.currentTarget).toEqualTypeOf<HTMLButtonElement>()}
      ref={(el) => expectTypeOf(el).toEqualTypeOf<HTMLButtonElement>()}
    />
  );
  void (<input onKeyDown={(event) => expectTypeOf(event).toExtend<KeyboardEvent>()} />);
  // @ts-expect-error 存在しないイベントハンドラーは型エラーになる
  void (<button onClik={() => {}} />);
});

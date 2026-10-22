import type { Props } from "rinka";
import { expectTypeOf, test } from "vitest";

import type { GlobalAttributes } from "../../../src/shared/jsx-attributes.ts";
import type { HostAttribute, PropNameError } from "../../../src/shared/prop-names.ts";

test("Props は、props にできる名前だけを持つ型を、そのまま返す", () => {
  type Card = { heading: string; count?: number; children?: unknown; onSelect?: () => void };
  expectTypeOf<Props<Card>>().toEqualTypeOf<Card>();
  expectTypeOf<Props<{ datum: string; area: string }>>().toEqualTypeOf<{
    datum: string;
    area: string;
  }>();
});

test("Props は、props にできない名前のキーがあると型エラーになる", () => {
  // @ts-expect-error ホストの属性になる名前
  expectTypeOf<Props<{ title: string }>>();
  // @ts-expect-error ホストの属性の名前は、大文字と小文字を区別せずに照合する
  expectTypeOf<Props<{ TabIndex: number }>>();
  // @ts-expect-error 予約された名前
  expectTypeOf<Props<{ ref: string }>>();
  // @ts-expect-error load: で始まる名前
  expectTypeOf<Props<{ "load:idle": boolean }>>();
  // @ts-expect-error HTMLElement のメンバー
  expectTypeOf<Props<{ focus: () => void }>>();
  // @ts-expect-error ライフサイクルのコールバック
  expectTypeOf<Props<{ connectedCallback: () => void }>>();
  // @ts-expect-error フォームの部品のホストに付与する API
  expectTypeOf<Props<{ validity: string }>>();
  // @ts-expect-error aria の直後に大文字が続く名前
  expectTypeOf<Props<{ ariaLabel: string }>>();
});

test("props にできない名前の型エラーのメッセージは、ビルドのエラーと同じく理由と代わりの名前を示す", () => {
  expectTypeOf<
    PropNameError<"title">
  >().toEqualTypeOf<'"title" は props の名前にできません。要素の全体にツールチップが表示されるためです。見出しには heading のような名前を使用してください。'>();
  expectTypeOf<
    PropNameError<"focus">
  >().toEqualTypeOf<'"focus" は props の名前にできません。props はホストのプロパティになり、ホストの focus を上書きするためです。要素の役割を表す別の名前を使用してください。'>();
  expectTypeOf<PropNameError<"heading">>().toEqualTypeOf<never>();
});

test("ホストのすべての属性は、props にできない名前である", () => {
  type Named = Exclude<keyof GlobalAttributes, `data-${string}` | `aria-${string}`>;
  expectTypeOf<Exclude<Named, HostAttribute>>().toEqualTypeOf<never>();
  expectTypeOf<Exclude<HostAttribute, Named>>().toEqualTypeOf<never>();
});

test("予約された props、aria と data、フォームの部品、ライフサイクルのコールバックの名前のメッセージも、ビルドのエラーと同じである", () => {
  expectTypeOf<
    PropNameError<"ref">
  >().toEqualTypeOf<'"ref" は props の名前にできません。rinka が要素への ref として扱うためです。内側のノードを受け取る関数には inputRef のような名前を使用してください。'>();
  expectTypeOf<
    PropNameError<"ariaLabel">
  >().toEqualTypeOf<'"ariaLabel" は props の名前にできません。rinka が aria-* と data-* の属性を、そのままホストに渡すためです。代わりに label のような名前を使用してください。'>();
  expectTypeOf<
    PropNameError<"validity">
  >().toEqualTypeOf<'"validity" は props の名前にできません。rinka がフォームの部品のホストに validity を付与するためです。要素の役割を表す別の名前を使用してください。'>();
  expectTypeOf<
    PropNameError<"connectedCallback">
  >().toEqualTypeOf<'"connectedCallback" は props の名前にできません。Custom Element のライフサイクルのコールバックと衝突するためです。要素の役割を表す別の名前を使用してください。'>();
});

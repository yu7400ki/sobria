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

test("props にできる名前の PropNameError は never である", () => {
  expectTypeOf<PropNameError<"heading">>().toEqualTypeOf<never>();
});

test("ホストのすべての属性は、props にできない名前である", () => {
  type Named = Exclude<keyof GlobalAttributes, `data-${string}` | `aria-${string}`>;
  expectTypeOf<Exclude<Named, HostAttribute>>().toEqualTypeOf<never>();
  expectTypeOf<Exclude<HostAttribute, Named>>().toEqualTypeOf<never>();
});

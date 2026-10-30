import type { SharedNode } from "sobria";
import { Fragment, jsx, jsxs } from "sobria/jsx-runtime";
import { expectTypeOf, test } from "vitest";

test("共通のコンポーネントの JSX は、要素とサーバーの両方のノードを返す", () => {
  expectTypeOf(jsx).returns.toEqualTypeOf<SharedNode>();
  expectTypeOf(jsxs).returns.toEqualTypeOf<SharedNode>();
  expectTypeOf(Fragment).returns.toEqualTypeOf<SharedNode>();
});

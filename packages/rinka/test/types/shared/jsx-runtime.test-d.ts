import type { SharedNode } from "rinka";
import { Fragment, jsx, jsxs } from "rinka/jsx-runtime";
import { expectTypeOf, test } from "vitest";

test("共通のコンポーネントの JSX は、要素とサーバーの両方のノードを返す", () => {
  expectTypeOf(jsx).returns.toEqualTypeOf<SharedNode>();
  expectTypeOf(jsxs).returns.toEqualTypeOf<SharedNode>();
  expectTypeOf(Fragment).returns.toEqualTypeOf<SharedNode>();
});

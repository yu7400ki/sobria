import type { ClientNode, ServerNode } from "rinka";
import { Fragment, jsx, jsxs } from "rinka/jsx-runtime";
import { expectTypeOf, test } from "vitest";

test("共通のコンポーネントの JSX は、要素とサーバーの両方のノードを返す", () => {
  expectTypeOf(jsx).returns.toEqualTypeOf<ClientNode & ServerNode>();
  expectTypeOf(jsxs).returns.toEqualTypeOf<ClientNode & ServerNode>();
  expectTypeOf(Fragment).returns.toEqualTypeOf<ClientNode & ServerNode>();
});

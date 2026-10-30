import { Errored, type ServerNode } from "sobria";
import { jsx } from "sobria/jsx-runtime";
import { redirect, renderToString } from "sobria/server";
import { describe, expectTypeOf, it } from "vitest";

describe("sobria-server の条件", () => {
  it("sobria は、サーバーの実装の型に解決する", () => {
    expectTypeOf(Errored).parameter(0).toHaveProperty("status");
  });

  it("sobria/jsx-runtime は、サーバーの JSX ランタイムに解決する", () => {
    expectTypeOf(jsx).returns.toEqualTypeOf<ServerNode>();
  });

  it("sobria/server は、サーバーの API の型に解決する", () => {
    expectTypeOf(renderToString).returns.resolves.toBeString();
    expectTypeOf(redirect).parameter(1).toEqualTypeOf<301 | 302 | 303 | 307 | 308 | undefined>();
  });
});

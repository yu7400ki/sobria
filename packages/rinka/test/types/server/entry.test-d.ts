import { Errored, effect, type Effect } from "rinka";
import { redirect, renderToString } from "rinka/server";
import { describe, expectTypeOf, it } from "vitest";

describe("rinka-server の条件", () => {
  it("rinka は、サーバーの実装の型に解決する", () => {
    expectTypeOf(Errored).parameter(0).toHaveProperty("status");
    expectTypeOf(effect).toEqualTypeOf<Effect>();
  });

  it("rinka/server は、サーバーの API の型に解決する", () => {
    expectTypeOf(renderToString).returns.resolves.toBeString();
    expectTypeOf(redirect).parameter(1).toEqualTypeOf<301 | 302 | 303 | 307 | 308 | undefined>();
  });
});

import * as server from "sobria/server";
import { expectTypeOf, test } from "vitest";

test("要素の側の sobria/server は、サーバー専用の API を持たない", () => {
  expectTypeOf(server).not.toHaveProperty("renderToResponse");
  expectTypeOf(server).not.toHaveProperty("redirect");
});

import { describe, expect, it } from "vitest";

import * as client from "../../src/client/index.ts";
import * as server from "../../src/server/index.ts";

describe("入口", () => {
  it("クライアントとサーバーの rinka は、同じ名前を export する", () => {
    expect(Object.keys(server).toSorted()).toEqual(Object.keys(client).toSorted());
  });

  it("サーバーの effect は、read と apply を呼ばない", () => {
    let called = 0;
    server.effect(
      () => called++,
      () => {
        called++;
      },
    );
    expect(called).toBe(0);
  });
});

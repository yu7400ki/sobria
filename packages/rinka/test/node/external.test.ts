import { createRenderEffect, createRoot, flush } from "@solidjs/signals";
import { describe, expect, it } from "vitest";

import { external as clientExternal } from "../../src/client/external.ts";
import { external } from "../../src/server/external.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToString } from "../../src/server/response.ts";

describe("サーバーの external", () => {
  it("getServerSnapshot の値を返し、subscribe と getSnapshot を呼ばない", async () => {
    const calls: string[] = [];
    const Search = () => {
      const search = external(
        () => {
          calls.push("subscribe");
          return () => {};
        },
        () => {
          calls.push("getSnapshot");
          return "?client";
        },
        () => "?server",
      );
      return jsx("p", { children: search });
    };
    expect(await renderToString(jsx(Search, {}))).toBe("<p>?server</p>");
    expect(calls).toEqual([]);
  });

  it("getServerSnapshot を省略していたら、エラーを投げる", () => {
    expect(() =>
      external(
        () => () => {},
        () => 1,
      ),
    ).toThrow(/getServerSnapshot/);
  });
});

const first = () => "a";
const noop = () => {};

describe("クライアントの external", () => {
  it("関数の値をそのまま返し、通知で同じ値を読み直したときは、読み取った計算を再実行しない", () => {
    let snapshot: () => string = first;
    let notify: () => void = noop;
    const runs: unknown[] = [];
    createRoot(() => {
      const read = clientExternal(
        (listener) => {
          notify = listener;
          return () => {};
        },
        () => snapshot,
      );
      createRenderEffect(read, (value) => {
        runs.push(value);
      });
    });
    flush();
    notify();
    flush();
    expect(runs).toEqual([first]);
    snapshot = () => "b";
    notify();
    flush();
    expect(runs).toEqual([first, snapshot]);
  });
});

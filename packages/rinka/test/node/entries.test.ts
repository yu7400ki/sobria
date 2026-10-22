import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as client from "../../src/client/index.ts";
import * as server from "../../src/server/index.ts";

describe("入口", () => {
  it("クライアントとサーバーの rinka は、同じ名前を export する", () => {
    expect(Object.keys(server).toSorted()).toEqual(Object.keys(client).toSorted());
  });

  it("package.json の exports が指すファイルは、ビルドした lib にある", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const paths: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === "string") paths.push(value);
      else if (typeof value === "object" && value !== null) Object.values(value).forEach(collect);
    };
    collect((manifest as { exports: unknown }).exports);
    const missing = paths.filter((path) => !existsSync(new URL(`../../${path}`, import.meta.url)));
    expect(missing).toEqual([]);
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

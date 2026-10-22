import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { entries, runtimes } from "../../src/build/entries.ts";
import * as client from "../../src/client/index.ts";
import * as server from "../../src/server/index.ts";

/** ビルドした lib の中の `path` のモジュールを読み込む。 */
const lib = (path: string): Promise<Record<string, unknown>> =>
  import(new URL(`../../lib/${path}`, import.meta.url).href);

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

  it("プラグインが環境ごとに解決する入口のファイルは、ビルドした lib にある", () => {
    const paths = [...Object.values(runtimes.client), ...Object.values(runtimes.server)];
    const missing = paths.filter(
      (path) => !existsSync(new URL(`../../lib/${path}`, import.meta.url)),
    );
    expect(missing).toEqual([]);
  });

  it("内部の入口は、コンパイラと開発サーバーが使用する関数を export する", async () => {
    const clientInternal = await lib(runtimes.client[entries.internal]!);
    const serverInternal = await lib(runtimes.server[entries.internal]!);
    expect(typeof clientInternal.stopIfSeeding).toBe("function");
    expect(typeof clientInternal.defineElement).toBe("function");
    expect(typeof serverInternal.createApp).toBe("function");
    expect(typeof serverInternal.defineElement).toBe("function");
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

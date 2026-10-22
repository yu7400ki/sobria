import { AsyncLocalStorage } from "node:async_hooks";

import { Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadStorage } from "../../src/server/context.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 読み込みに失敗する、`node:async_hooks` の代わりの関数である。 */
const unavailable = () => Promise.reject(new Error("読み込めません"));

const request = (path: string) => new Context(new Request(`http://localhost${path}`));

describe("リクエストの Context の保持", () => {
  it("グローバルに AsyncLocalStorage があれば、それを使用する", async () => {
    class Global extends AsyncLocalStorage<Context> {}
    vi.stubGlobal("AsyncLocalStorage", Global);
    expect(await loadStorage(unavailable)).toBeInstanceOf(Global);
  });

  it("グローバルに無ければ、node:async_hooks の AsyncLocalStorage を使用し、await をまたいで値を保持する", async () => {
    const storage = await loadStorage();
    const c = request("/a");
    const seen = await storage.run(c, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return storage.getStore();
    });
    expect(seen).toBe(c);
  });

  it("どちらも無ければ、同期的な代用品を使用し、警告を出力する", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = await loadStorage(unavailable);
    const c = request("/a");
    expect(storage.run(c, () => storage.getStore())).toBe(c);
    expect(storage.getStore()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

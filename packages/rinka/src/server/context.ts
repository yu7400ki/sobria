import { AsyncLocalStorage } from "node:async_hooks";

import { Context } from "hono";

const storage = new AsyncLocalStorage<Context>();

/** `fn` を、`c` を処理中のリクエストの Context として実行する。 */
export function runInRequest<T>(c: Context, fn: () => T): T {
  return storage.run(c, fn);
}

/** 処理中のリクエストの Context を返す。リクエストの外では、`/` へ GET するリクエストを表す空の Context を返す。 */
export function currentContext(): Context {
  return storage.getStore() ?? new Context(new Request("http://localhost/"));
}

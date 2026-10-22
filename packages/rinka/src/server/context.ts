import { Context } from "hono";

/** リクエストの Context を保持する、AsyncLocalStorage と同じ形のオブジェクトを表す。 */
interface Storage {
  run<T>(c: Context, fn: () => T): T;
  getStore(): Context | undefined;
}

type StorageClass = new () => Storage;

/**
 * Context を保持するオブジェクトを返す。グローバルに AsyncLocalStorage があればそれを使用し、無ければ `importAsyncHooks` で読み込んだ `node:async_hooks` のものを使用する。
 * どちらも無ければ、`await` をまたぐと値を失う同期的な代用品を使用し、警告を出力する。
 */
export async function loadStorage(
  importAsyncHooks: () => Promise<{ AsyncLocalStorage: StorageClass }> = () =>
    import("node:async_hooks"),
): Promise<Storage> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const global = (globalThis as { AsyncLocalStorage?: StorageClass }).AsyncLocalStorage;
  if (global) return new global();
  try {
    const { AsyncLocalStorage } = await importAsyncHooks();
    return new AsyncLocalStorage();
  } catch {
    console.warn(
      "[rinka] AsyncLocalStorage を使用できないので、サーバー関数が受け取るリクエストの Context は、await をまたぐと失われ、同時に処理するリクエストのあいだで混在します。",
    );
    return synchronousStorage();
  }
}

function synchronousStorage(): Storage {
  let current: Context | undefined;
  return {
    run(c, fn) {
      const previous = current;
      current = c;
      try {
        return fn();
      } finally {
        current = previous;
      }
    },
    getStore: () => current,
  };
}

let storage: Storage | undefined;
let loading: Promise<Storage> | undefined;

/** `fn` を、`c` を処理中のリクエストの Context として実行する。 */
export async function runInRequest<T>(c: Context, fn: () => T | Promise<T>): Promise<T> {
  storage ??= await (loading ??= loadStorage());
  return storage.run(c, fn);
}

/** 処理中のリクエストの Context を返す。リクエストの外では、`/` へ GET するリクエストを表す空の Context を返す。 */
export function currentContext(): Context {
  return storage?.getStore() ?? new Context(new Request("http://localhost/"));
}

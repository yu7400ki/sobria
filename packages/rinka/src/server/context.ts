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
  return getContext() ?? new Context(new Request("http://localhost/"));
}

/** 処理中のリクエストの Hono の Context を返す。リクエストの外では `undefined` を返す。 */
export function getContext(): Context | undefined {
  return storage?.getStore();
}

/**
 * `response` に、Context で設定したヘッダーを加えて返す。
 * `Set-Cookie` は、Context で設定したものを順に並べ、`response` のうち Context で設定していないものを後に加える。
 * `Vary` は、Context で設定した値の後に、`response` の値のうち Context で設定していないものを連結する。
 */
export function withContextHeaders(c: Pick<Context, "newResponse">, response: Response): Response {
  const context = c.newResponse(null).headers;
  const pending = context.getSetCookie();
  const added = response.headers.getSetCookie().filter((cookie) => {
    const index = pending.indexOf(cookie);
    if (index === -1) return true;
    pending.splice(index, 1);
    return false;
  });
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  const vary = new Map<string, string>();
  for (const value of [context.get("vary"), response.headers.get("vary")]) {
    for (const name of value?.split(",") ?? []) {
      const trimmed = name.trim();
      if (trimmed !== "" && !vary.has(trimmed.toLowerCase()))
        vary.set(trimmed.toLowerCase(), trimmed);
    }
  }
  if (vary.size > 0) headers.set("vary", [...vary.values()].join(", "));
  const init = new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  const merged = c.newResponse(response.body, init);
  for (const cookie of added) merged.headers.append("set-cookie", cookie);
  return merged;
}

/**
 * `c.res` を `response` に置換し、置換した Response を返す。前の `c.res` のヘッダーは統合しない。
 * `response` が Promise なら、完了を待つ前に `c.res` を空にする。
 */
export function replaceResponse(c: Context, response: Response): Response;
export function replaceResponse(
  c: Context,
  response: Response | Promise<Response>,
): Response | Promise<Response>;
export function replaceResponse(
  c: Context,
  response: Response | Promise<Response>,
): Response | Promise<Response> {
  c.res = undefined;
  if (response instanceof Response) {
    c.res = response;
    return response;
  }
  return response.then((value) => {
    c.res = value;
    return value;
  });
}

/** リクエストの Context ごとの、すべての `<Loading>` を待って描画するかどうかの指定である。 */
const blockingRenders = new WeakMap<object, boolean>();

/** リクエスト `c` のページを、すべての `<Loading>` の中身を待って描画するかどうかを指定する。指定しなければ、bot の User-Agent のリクエストだけを待って描画する。 */
export function setBlockingRender(c: Context, value: boolean): void {
  blockingRenders.set(c, value);
}

/** リクエスト `c` に `setBlockingRender` で指定した値を返す。指定していなければ undefined を返す。 */
export const blockingRenderOf = (c: object): boolean | undefined => blockingRenders.get(c);

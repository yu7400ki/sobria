import { serverFnRefOf } from "../shared/server-fn.ts";
import type { ServerFnMethod } from "../shared/server-fn.ts";
import { getContext } from "./context.ts";
import type { ServerFn } from "./server-fn.ts";

/** handler の戻り値の型 `R` のうち、`getServerFnResult` が返す値の型である。ストリームなら `never` である。 */
type ResultOf<R> = Awaited<R> extends AsyncIterable<unknown> ? never : Awaited<R>;

/** `Request` をキーにして、そのリクエストでサーバー関数が返した値と、サーバー関数の ID を保持する。 */
const results = new WeakMap<Request, { readonly id: string; readonly value: unknown }>();

/** リクエスト `request` で、ID が `id` のサーバー関数が値 `value` を返したことを記録する。 */
export function recordResult(request: Request, id: string, value: unknown): void {
  results.set(request, { id, value });
}

/** リクエスト `request` に記録した値を削除する。 */
export function forgetResult(request: Request): void {
  results.delete(request);
}

/** リクエスト `from` に記録した値を、サブリクエスト `to` にも記録する。 */
export function inheritResult(from: Request, to: Request): void {
  const result = results.get(from);
  if (result !== undefined) results.set(to, result);
}

/**
 * ページを描画するきっかけになったリクエストで、サーバー関数 `fn` が返した値を返す。
 * 対象のリクエストは、フォームの送信と、JS からの呼び出しの後に、送信したページや呼び出したページを描画するリクエストである。
 * そのリクエストで `fn` が値を返していなければ、別のサーバー関数が値を返していても `undefined` を返す。
 * `fn` がストリームを返したときと、サーバー関数のミドルウェアが例外を投げたときも `undefined` を返す。
 */
export function getServerFnResult<In, R, M extends ServerFnMethod>(
  fn: ServerFn<In, R, M>,
): ResultOf<R> | undefined {
  const request = getContext()?.req.raw;
  const result = request === undefined ? undefined : results.get(request);
  if (result === undefined || result.id !== serverFnRefOf(fn)?.id) return undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return result.value as ResultOf<R>;
}

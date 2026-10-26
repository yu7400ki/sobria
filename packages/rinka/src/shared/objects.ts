/** 関数かどうかを返す。 */
export const isFunction = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === "function";

/** `value` が、`then` を持つ値かどうかを返す。 */
export const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && "then" in value && isFunction(value.then);

/** `Symbol.asyncIterator` を持つオブジェクトなら真を返す。 */
export const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value;

/** `iterator` の `return()` を呼ぶ。`return()` が投げた値と、reject した値は無視する。 */
export async function closeIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  await Promise.resolve()
    .then(() => iterator.return?.())
    .catch(() => {});
}

/** プロトタイプが `Object.prototype` か `null` のオブジェクトかどうかを返す。 */
export function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

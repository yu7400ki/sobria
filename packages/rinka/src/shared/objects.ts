/** プロトタイプが `Object.prototype` か `null` のオブジェクトかどうかを返す。 */
export function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** RPC のリクエストとレスポンスで、値の形式を示すヘッダーの名前。 */
export const wireHeader = "x-rinka-wire";

/** `wireHeader` に設定する値。`rpc` は rinka が構築したレスポンスを示し、`seroval` は本文が seroval の JSON の形式であることを示す。 */
export const wireFormat = { rpc: "rpc", seroval: "seroval" } as const;

/** `JSON.parse(JSON.stringify(value))` が `value` と同じ値を返すかどうかを返す。 */
export function isJson(value: unknown): boolean {
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value) && !Object.is(value, -0);
    case "object": {
      if (value === null) return true;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (!(i in value) || !isJson(value[i])) return false;
        }
        return true;
      }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      return Object.values(value).every(isJson);
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return false;
  }
}

const builtins = [Date, RegExp, Map, Set, ArrayBuffer, DataView];

/**
 * seroval でシリアライズできない値を `value` の中から探索し、`path` に続けてその値の位置を示すエラーを投げる。
 * `allowFunction` が `true` を返す関数は、送信できる値として扱う。
 */
export function checkSerializable(
  value: unknown,
  path: string,
  allowFunction?: (fn: Function) => boolean,
  seen = new Set<object>(),
): void {
  if (typeof value === "function") {
    if (allowFunction?.(value)) return;
    throw new Error(
      `${path} は関数なので、シリアライズできません。サーバーから要素に渡せる関数は、サーバー関数だけです。`,
    );
  }
  if (typeof value === "symbol")
    throw new Error(`${path} は symbol なので、シリアライズできません。`);
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  const check = (item: unknown, at: string) => checkSerializable(item, at, allowFunction, seen);
  if (Array.isArray(value)) {
    value.forEach((item: unknown, i) => check(item, `${path}[${i}]`));
    return;
  }
  if (value instanceof Map) {
    for (const [key, item] of value as Map<unknown, unknown>) {
      check(key, `${path} のキー`);
      check(item, `${path}.get(${String(key)})`);
    }
    return;
  }
  if (value instanceof Set) {
    for (const item of value as Set<unknown>) check(item, `${path} の要素`);
    return;
  }
  if (ArrayBuffer.isView(value) || builtins.some((type) => value instanceof type)) return;
  if (value instanceof Error) {
    throw new Error(
      `${path} は Error なので、送信できません。サーバーのスタックトレースが含まれるためです。{ message } のようなオブジェクトにして送信してください。`,
    );
  }
  if (value instanceof Promise) {
    throw new Error(
      `${path} は Promise なので、シリアライズできません。await してから渡してください。`,
    );
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "クラス";
    throw new Error(
      `${path} は ${name} のインスタンスなので、シリアライズできません。プレーンなオブジェクト、配列、Date、Map、Set などを送信してください。`,
    );
  }
  for (const [key, item] of Object.entries(value)) check(item, `${path}.${key}`);
}

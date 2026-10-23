import type { SerovalJSON } from "seroval";

import { isPlainObject } from "./objects.ts";
import { serverFnRefOf } from "./server-fn.ts";

/** RPC のリクエストとレスポンスで、値の形式を示すヘッダーの名前。 */
export const wireHeader = "x-rinka-wire";

/** `wireHeader` に設定する値。`rpc` は rinka が構築したレスポンスを示し、`seroval` は本文が seroval の JSON の形式であることを示す。 */
export const wireFormat = { rpc: "rpc", seroval: "seroval" } as const;

/** GET の RPC で入力を送るクエリの名前を表す。`json` は素の JSON を、`seroval` は seroval の JSON の形式を示す。 */
export const rpcQuery = { json: "d", seroval: "s" } as const;

/** サーバー関数のエンドポイントの URL のパスの接頭辞である。 */
export const rpcPrefix = "/_rinka/fn/";

/** ID が `id` のサーバー関数のエンドポイントの URL のパスを返す。 */
export const rpcPath = (id: string): string => rpcPrefix + encodeURIComponent(id);

/** rinka が構築した RPC のレスポンスのうち、値を返すときの本文を表す。 */
export type RpcBody = { ok: unknown } | { s: SerovalJSON };

/** `value` が、seroval の JSON の形式の外側の形を持つかどうかを返す。 */
export const isSerovalJson = (value: unknown): value is SerovalJSON =>
  typeof value === "object" &&
  value !== null &&
  "t" in value &&
  typeof value.t === "object" &&
  value.t !== null &&
  "f" in value &&
  typeof value.f === "number" &&
  "m" in value &&
  Array.isArray(value.m);

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
      return isPlainObject(value) && Object.values(value).every(isJson);
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
 * `serverFns` が真なら、ID とメソッドを保持するサーバー関数を、シリアライズできる値として扱う。
 */
export function checkSerializable(value: unknown, path: string, serverFns: boolean): void {
  check(value, path, serverFns, new Set());
}

function check(value: unknown, path: string, serverFns: boolean, seen: Set<object>): void {
  if (typeof value === "function" && !(serverFns && serverFnRefOf(value))) {
    throw new Error(
      `${path} は関数なので、シリアライズできません。サーバーから要素に渡せる関数は、サーバー関数だけです。`,
    );
  }
  if (typeof value === "symbol")
    throw new Error(`${path} は symbol なので、シリアライズできません。`);
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  const next = (item: unknown, at: string) => check(item, at, serverFns, seen);
  if (Array.isArray(value)) {
    value.forEach((item: unknown, i) => next(item, `${path}[${i}]`));
    return;
  }
  if (value instanceof Map) {
    for (const [key, item] of value as Map<unknown, unknown>) {
      next(key, `${path} のキー`);
      next(item, `${path}.get(${String(key)})`);
    }
    return;
  }
  if (value instanceof Set) {
    for (const item of value as Set<unknown>) next(item, `${path} の要素`);
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
  if (!isPlainObject(value)) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "クラス";
    throw new Error(
      `${path} は ${name} のインスタンスなので、シリアライズできません。プレーンなオブジェクト、配列、Date、Map、Set などを送信してください。`,
    );
  }
  for (const [key, item] of Object.entries(value)) next(item, `${path}.${key}`);
}

/**
 * `<form>` の props を返す。`action` がサーバー関数なら、`action` をエンドポイントの URL に、`method` を `post` に、
 * `enctype` を `multipart/form-data` にする。`enctype` を記述していれば、その値を使用する。
 */
export function formProps(props: Record<string, unknown>): Record<string, unknown> {
  const ref = serverFnRefOf(props.action);
  if (!ref) return props;
  const { enctype = "multipart/form-data" } = props;
  return { ...props, action: rpcPath(ref.id), method: "post", enctype };
}

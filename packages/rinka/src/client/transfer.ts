import { createMemo, type SourceAccessor } from "@solidjs/signals";

import { runSeeding } from "../shared/scope.ts";

/** 起動スクリプトが `window.$rinka` に定義する受け口のうち、値の引き継ぎで使用するものを表す。 */
interface Receiver {
  /** ホストの ID ごとに、引き継ぐ値をキーごとに保持する。 */
  readonly v: Record<string, Record<string, unknown> | undefined>;
  /** ホストの ID ごとに、値が届いたときに呼ぶ関数を保持する。 */
  readonly l: Record<string, (() => void)[] | undefined>;
  /** ホストの ID ごとに、`data-om` に加えて待つキーを保持する。 */
  readonly w: Record<string, string[] | undefined>;
  /** 値が無いことを表すオブジェクトである。 */
  readonly n: object;
}

declare global {
  /** 起動スクリプトが定義する受け口である。起動スクリプトを読み込んでいないページでは `undefined` である。 */
  var $rinka: Receiver | undefined;
}

/** `window.$rinka` を返す。起動スクリプトを読み込んでいなければ `undefined` を返す。 */
const receiver = (): Receiver | undefined => globalThis.$rinka;

/** ホストが起動の前に待つキーを返す。`data-om` のキーと、起動スクリプトが追加したキーである。 */
function waitedKeys(host: Element, id: string): string[] {
  const keys = (host.getAttribute("data-om") ?? "").split(" ").filter(Boolean);
  return [...keys, ...(receiver()?.w[id] ?? [])];
}

/** ホストが待つキーの値が、すべて届いているかどうかを返す。 */
function arrived(host: Element, id: string): boolean {
  const values = receiver()?.v[id] ?? {};
  return waitedKeys(host, id).every((key) => Object.hasOwn(values, key));
}

/**
 * SSR したホストが待つキーの値が、すべて届いていれば `undefined` を返す。
 * 届いていなければ、すべて届いた時点で `ready` を呼ぶ待機を登録し、待機を取り消す関数を返す。
 * 起動スクリプトを読み込んでいないページでは、`undefined` を返す。
 */
export function whenArrived(
  host: Element,
  id: string,
  ready: () => void,
): (() => void) | undefined {
  const store = receiver();
  if (!store || arrived(host, id)) return undefined;
  const listeners = (store.l[id] ??= []);
  const listener = () => {
    if (!arrived(host, id)) return;
    cancel();
    ready();
  };
  const cancel = () => {
    const index = listeners.indexOf(listener);
    if (index !== -1) listeners.splice(index, 1);
  };
  listeners.push(listener);
  return cancel;
}

/** ホストに引き継いだ値のうち、値が無いことを表すオブジェクトを除いたものを、キーごとに返す。 */
export function transferredValues(id: string): Map<string, unknown> {
  const store = receiver();
  const values = new Map<string, unknown>();
  for (const [key, value] of Object.entries(store?.v[id] ?? {})) {
    if (value !== store?.n) values.set(key, value);
  }
  return values;
}

/**
 * 引き継いだ `value` を最初の値にする memo を作成する。最初の計算では、依存を登録するために `compute` をシードとして 1 回呼び、戻り値を使用しない。
 * 2 回目以降の計算では、`compute` の戻り値を使用する。
 */
export function seededMemo<T>(
  value: T,
  compute: (prev: T | undefined) => T | PromiseLike<T>,
): SourceAccessor<T> {
  let seeding = true;
  return createMemo<T>((prev) => {
    if (!seeding) return compute(prev);
    seeding = false;
    const result = runSeeding(() => compute(value));
    void Promise.resolve(result).catch(() => {});
    return value;
  });
}

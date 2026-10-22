import type { SourceAccessor } from "@solidjs/signals";

/** キーで識別する memo を作成する関数を表す。`fn` は memo の関数である。 */
export type ScopedMemo = <T>(
  key: string,
  fn: (prev: T | undefined) => T | PromiseLike<T>,
) => SourceAccessor<T>;

/** 要素のインスタンスの描画の範囲を表す。範囲の中で作成する、キーのある memo の作り方を決める。 */
export interface MemoScope {
  readonly memo: ScopedMemo;
  /** 呼び出し箇所ごとに、作成した memo の数を保持する。 */
  readonly counts: Map<string, number>;
}

/** `memo` でキーのある memo を作成する、描画の範囲を作成する。 */
export const createScope = (memo: ScopedMemo): MemoScope => ({ memo, counts: new Map() });

let current: MemoScope | undefined;
let seeding = false;

/** `fn` を `scope` の描画の範囲で実行する。 */
export function withScope<T>(scope: MemoScope, fn: () => T): T {
  const previous = current;
  current = scope;
  try {
    return fn();
  } finally {
    current = previous;
  }
}

/** memo を識別するための、`memo` の 2 番目の引数を表す。 */
export interface MemoOptions {
  /** 明示的なキー。 */
  readonly key?: string;
  /** 呼び出し箇所の ID。Vite プラグインが付与する。 */
  readonly site?: string;
}

/**
 * 描画の範囲の中なら、範囲と memo のキーを返す。キーは、明示的なキーか、呼び出し箇所とその箇所で何回目に作成したかである。
 * 範囲の外か、キーも呼び出し箇所も無ければ `undefined` を返す。
 */
export function scopedKey(options: MemoOptions | undefined): [MemoScope, string] | undefined {
  if (!current || !options) return undefined;
  if (options.key !== undefined) return [current, options.key];
  if (options.site === undefined) return undefined;
  const count = current.counts.get(options.site) ?? 0;
  current.counts.set(options.site, count + 1);
  return [current, `${options.site}#${count}`];
}

/** 引き継いだ値を使う memo の、最初の計算（シード）の最中かどうかを返す。 */
export const isSeeding = (): boolean => seeding;

/** `fn` をシードとして実行する。 */
export function runSeeding<T>(fn: () => T): T {
  const previous = seeding;
  seeding = true;
  try {
    return fn();
  } finally {
    seeding = previous;
  }
}

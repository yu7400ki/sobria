import { createMemo, type ComputeFunction, type SourceAccessor } from "@solidjs/signals";

import { isReservedKey } from "./transfer-keys.ts";

/**
 * memo の関数を表す。直前の値を受け取って、memo の新しい値を返す。Promise を返すと、解決した値が memo の値になる。
 * async iterable を返すと、yield した値が届くたびに memo の値になる。
 */
export type MemoCompute<T> = (
  prev: T | undefined,
) => T | PromiseLike<T> | AsyncIterable<T> | PromiseLike<AsyncIterable<T>>;

/** `fn` の memo を作成する。`options` は `@solidjs/signals` の `createMemo` のオプションである。 */
export function memoOf<T>(
  fn: MemoCompute<T>,
  options?: Parameters<typeof createMemo<T>>[1],
): SourceAccessor<T> {
  // `createMemo` は、関数が返した Promise が async iterable に解決すると、その iterable を反復する。`createMemo` の引数の型には、async iterable に解決する Promise を含めない。
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return createMemo(fn as ComputeFunction<T | undefined, T>, options);
}

/** キーで識別する memo を作成する関数を表す。 */
export type ScopedMemo = <T>(key: string, fn: MemoCompute<T>) => SourceAccessor<T>;

/** 要素のインスタンスの描画の範囲を表す。範囲の中で作成する、キーのある memo の作り方を決定する。 */
export interface MemoScope {
  readonly memo: ScopedMemo;
  /** 範囲を作成した側が、範囲の中で作成した子要素に渡す値である。 */
  readonly data: unknown;
  /** 呼び出し箇所ごとに、memo と子要素を作成した数を保持する。 */
  readonly counts: Map<string, number>;
  /** 使用した明示的なキーを保持する。 */
  readonly explicitKeys: Set<string>;
}

/** キーのある memo を `memo` で作成し、子要素に `data` を渡す、描画の範囲を返す。 */
export const createScope = (memo: ScopedMemo, data?: unknown): MemoScope => ({
  memo,
  data,
  counts: new Map(),
  explicitKeys: new Set(),
});

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

/** `fn` を、描画の範囲の外で実行する。 */
export function outsideScope<T>(fn: () => T): T {
  const previous = current;
  current = undefined;
  try {
    return fn();
  } finally {
    current = previous;
  }
}

/** `memo` の 2 番目の引数を表す。 */
export interface MemoOptions {
  /** 描画の範囲の中で、memo を識別するキーを表す。 */
  readonly key?: string;
}

/** Vite プラグインが付与する呼び出し箇所の ID を加えた、`memo` の 2 番目の引数を表す。 */
export interface SiteMemoOptions extends MemoOptions {
  /** 呼び出し箇所の ID を表す。 */
  readonly site?: string;
}

/** 明示的なキーの形式と、同じ範囲で重複していないことを確認する。規則に合わなければ、エラーを投げる。 */
function checkKey(scope: MemoScope, key: string): void {
  if (key === "" || /\s/.test(key) || isReservedKey(key)) {
    throw new Error(
      `memo の明示的なキー ${JSON.stringify(key)} は使用できません。空白を含まず、@ で始まらない、空でない文字列を指定してください。`,
    );
  }
  if (scope.explicitKeys.has(key)) {
    throw new Error(
      `memo の明示的なキー ${JSON.stringify(key)} は、同じ要素の中で既に使用しています。`,
    );
  }
  scope.explicitKeys.add(key);
}

/**
 * 描画の範囲の中なら、キーを決定し、範囲の `memo` で memo を作成して返す。キーは、明示的なキーか、呼び出し箇所とその箇所で何回目に作成したかである。
 * 範囲の外か、キーも呼び出し箇所も無ければ `undefined` を返す。
 */
export function scopedMemo<T>(
  fn: MemoCompute<T>,
  options: SiteMemoOptions | undefined,
): SourceAccessor<T> | undefined {
  if (!current || !options) return undefined;
  if (options.key !== undefined) {
    if (import.meta.env?.DEV) checkKey(current, options.key);
    return current.memo(options.key, fn);
  }
  if (options.site === undefined) return undefined;
  return current.memo(countedKey(current, options.site), fn);
}

/** `scope` の中で呼び出し箇所 `site` が何回目かを数え、呼び出し箇所と回数のキーを返す。 */
function countedKey(scope: MemoScope, site: string): string {
  const count = scope.counts.get(site) ?? 0;
  scope.counts.set(site, count + 1);
  return `${site}#${count}`;
}

/** 描画の範囲の中で作成した子要素を表す。`data` は子要素を作成した範囲の `data`、`key` は呼び出し箇所と回数のキーである。 */
export interface ScopedChild {
  readonly data: unknown;
  readonly key: string;
}

/** 描画の範囲の中で、呼び出し箇所が `site` の子要素を作成するなら、範囲の `data` とキーを返す。範囲の外か、呼び出し箇所が無ければ `undefined` を返す。 */
export function scopedChild(site: string | undefined): ScopedChild | undefined {
  if (!current || site === undefined) return undefined;
  return { data: current.data, key: countedKey(current, site) };
}

/**
 * シードの最中かどうかを返す。シードは、サーバーから引き継いだ値を最初の値にした memo で、関数を 1 回実行して依存を登録する計算である。
 */
export const isSeeding = (): boolean => seeding;

/** `fn` を実行する。実行している間は、`isSeeding` が真を返す。 */
export function runSeeding<T>(fn: () => T): T {
  const previous = seeding;
  seeding = true;
  try {
    return fn();
  } finally {
    seeding = previous;
  }
}

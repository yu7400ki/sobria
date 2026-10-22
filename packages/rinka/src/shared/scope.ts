import type { SourceAccessor } from "@solidjs/signals";

/** キーで識別する memo を作成する関数を表す。`fn` は、直前の値を受け取って、memo の新しい値を返す。 */
export type ScopedMemo = <T>(
  key: string,
  fn: (prev: T | undefined) => T | PromiseLike<T>,
) => SourceAccessor<T>;

/** 要素のインスタンスの描画の範囲を表す。範囲の中で作成する、キーのある memo の作り方を決定する。 */
export interface MemoScope {
  readonly memo: ScopedMemo;
}

/** 描画の範囲ごとに、呼び出し箇所ごとに作成した memo の数を保持する。 */
const counts = new WeakMap<MemoScope, Map<string, number>>();

/** `memo` でキーのある memo を作成する、描画の範囲を作成する。 */
export const createScope = (memo: ScopedMemo): MemoScope => ({ memo });

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

/** `memo` の 2 番目の引数を表す。 */
export interface MemoOptions {
  /** 描画の範囲の中で、memo を識別するキーを表す。 */
  readonly key?: string;
  /** 呼び出し箇所の ID を表す。Vite プラグインが付与する。 */
  readonly site?: string;
}

/** 描画の範囲ごとに、使用した明示的なキーを保持する。 */
const explicitKeys = new WeakMap<MemoScope, Set<string>>();

/** 明示的なキーが、空でなく、空白を含まず、`@` で始まらず、同じ範囲で使用していないことを確認する。 */
function checkKey(scope: MemoScope, key: string): void {
  if (key === "" || /\s/.test(key) || key.startsWith("@")) {
    throw new Error(
      `memo の明示的なキー ${JSON.stringify(key)} は使用できません。空白を含まず、@ で始まらない、空でない文字列を指定してください。`,
    );
  }
  let keys = explicitKeys.get(scope);
  if (!keys) explicitKeys.set(scope, (keys = new Set<string>()));
  if (keys.has(key)) {
    throw new Error(
      `memo の明示的なキー ${JSON.stringify(key)} は、同じ要素の中で既に使用しています。`,
    );
  }
  keys.add(key);
}

/**
 * 描画の範囲の中なら、キーを決定し、範囲の `memo` で memo を作成して返す。キーは、明示的なキーか、呼び出し箇所とその箇所で何回目に作成したかである。
 * 範囲の外か、キーも呼び出し箇所も無ければ `undefined` を返す。
 */
export function scopedMemo<T>(
  fn: (prev: T | undefined) => T | PromiseLike<T>,
  options: MemoOptions | undefined,
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
  let sites = counts.get(scope);
  if (!sites) counts.set(scope, (sites = new Map<string, number>()));
  const count = sites.get(site) ?? 0;
  sites.set(site, count + 1);
  return `${site}#${count}`;
}

/** 描画の範囲の中で作成した子要素を表す。`scope` は子要素を作成した範囲、`key` は呼び出し箇所と回数のキーである。 */
export interface ScopedChild {
  readonly scope: MemoScope;
  readonly key: string;
}

/** 描画の範囲の中で、呼び出し箇所が `site` の子要素を作成するなら、範囲とキーを返す。範囲の外か、呼び出し箇所が無ければ `undefined` を返す。 */
export function scopedChild(site: string | undefined): ScopedChild | undefined {
  if (!current || site === undefined) return undefined;
  return { scope: current, key: countedKey(current, site) };
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

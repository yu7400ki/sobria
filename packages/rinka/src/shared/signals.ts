import {
  action as solidAction,
  createOptimistic,
  createSignal,
  isPending as solidIsPending,
  refresh as solidRefresh,
  type SourceAccessor,
} from "@solidjs/signals";

import {
  memoOf,
  scopedMemo,
  type MemoCompute,
  type MemoOptions,
  type SiteMemoOptions,
} from "./scope.ts";

/** 読み取りの関数を表す。 */
export type Accessor<T> = () => T;

/**
 * 書き込みの関数を表す。値か、直前の値を受け取って新しい値を返す関数を受け取り、書き込んだ値を返す。
 * 関数を値として書き込むときは、その関数を返す関数を渡す。
 */
export type Setter<T> = <U extends T>(value: Exclude<U, Function> | ((prev: T) => U)) => U;

/** 読み取りの関数と書き込みの関数の組を表す。 */
export type Signal<T> = [get: Accessor<T>, set: Setter<T>];

/** signal を作成するときのオプションを表す。 */
export interface SignalOptions<T> {
  /** 書き込んだ値が前の値と等しいかを判定する。`false` なら、書き込むたびに変化したものとして扱う。 */
  readonly equals?: false | ((prev: T, next: T) => boolean);
}

declare const memoBrand: unique symbol;

/** memo の読み取りの関数を表す。`refresh` に渡すと、値を取り直す。 */
export interface Memo<T> {
  (): T;
  readonly [memoBrand]: true;
}

/** `read` が読み取った値が変化するたびに、`read` の戻り値を `apply` に渡して呼ぶ関数を表す。 */
export type Effect = <T>(read: () => T, apply: (value: T) => void | (() => void)) => void;

/** 読み取りの関数と書き込みの関数の組を作成する。書き込んだ値は、次の flush の時点で読み取りに反映される。 */
export const signal: {
  <T>(): Signal<T | undefined>;
  <T>(value: Exclude<T, Function>, options?: SignalOptions<T>): Signal<T>;
} = createSignal;

/** `memo` と同じ値を作成する。要素の描画の範囲の中では、`options` の `key` か `site` で memo を識別する。 */
export function siteMemo<T>(fn: MemoCompute<T>, options?: SiteMemoOptions): Memo<T> {
  const read: Accessor<T> = scopedMemo(fn, options) ?? memoOf(fn);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return read as Memo<T>;
}

/**
 * ほかの signal や memo から計算する値を作成する。関数は Promise か async iterable を返してもよい。
 * async iterable を返すと、memo は値が届くたびにその値に置き換わる。
 * 要素の描画の範囲の中では、`options` の `key` か、Vite プラグインが付与する呼び出し箇所の ID で memo を識別する。
 */
export const memo: <T>(fn: MemoCompute<T>, options?: MemoOptions) => Memo<T> = siteMemo;

/**
 * action の中で書き込むとすぐに反映され、action が終わると元の値に戻る値を作成する。
 * 関数を渡すと、action が終わった時点で関数が返す値に戻る。
 */
export const optimistic: {
  <T>(): Signal<T | undefined>;
  <T>(value: Exclude<T, Function>, options?: SignalOptions<T>): Signal<T>;
  <T>(fn: (prev: T | undefined) => T | PromiseLike<T>, options?: SignalOptions<T>): Signal<T>;
} = createOptimistic;

/**
 * memo が一度解決した後に、依存する値が変化して値を取り直している間、`true` を返す。
 * `refresh` で取り直している間は `false` を返す。
 */
export const isPending: (target: Accessor<unknown>) => boolean = solidIsPending;

/** memo を取り直す。取り直した値が解決すると解決する Promise を返す。 */
export function refresh<T>(target: Memo<T>): Promise<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return solidRefresh(target as unknown as SourceAccessor<T>);
}

/** `action` が返す関数を表す。 */
export type Action<Args extends unknown[], R> = ((...args: Args) => Promise<R>) & {
  /** この action の呼び出しが実行中かどうかを返す。 */
  pending(): boolean;
};

/**
 * generator 関数の中の書き込みを、1 つのトランザクションとして実行する関数を作成する。
 * action は、generator が yield した Promise が解決するまで待ってから、generator を再開する。
 * generator の中の普通の signal への書き込みは、`yield` の前後にかかわらず action の終わりまで保留される。
 * 同時に呼び出した action は、すべてが終わったときに一緒に終わる。
 */
export function action<Args extends unknown[], R>(
  fn: (...args: Args) => Generator<PromiseLike<unknown>, R, unknown>,
): Action<Args, R> {
  const [pending, setPending] = createOptimistic(false);
  const run = solidAction(function* (...args: Args): Generator<PromiseLike<unknown>, R, unknown> {
    setPending(true);
    return yield* fn(...args);
  });
  return Object.assign((...args: Args) => run(...args), { pending });
}

/**
 * action の generator の中で `yield* wait(promise)` と記述すると、その式の値は Promise が解決した値になる。
 * Promise が reject すると、その理由が `yield*` の位置で投げられる。
 */
export function* wait<T>(promise: PromiseLike<T>): Generator<PromiseLike<T>, T, unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (yield promise) as T;
}

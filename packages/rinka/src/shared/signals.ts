import {
  action as solidAction,
  createMemo,
  createOptimistic,
  createSignal,
  isPending as solidIsPending,
  refresh as solidRefresh,
  type SourceAccessor,
} from "@solidjs/signals";

import { scopedMemo, type MemoOptions } from "./scope.ts";

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

/** 読み取りの関数と書き込みの関数の組を作成する。書き込んだ値は、flush されるまで読み取りに反映されない。 */
export const signal: {
  <T>(): Signal<T | undefined>;
  <T>(value: Exclude<T, Function>, options?: SignalOptions<T>): Signal<T>;
} = createSignal;

/**
 * ほかの signal や memo から計算する値を作成する。関数は Promise を返してもよい。
 * `options` は、要素の描画の範囲の中で memo を識別する。
 */
export function memo<T>(
  fn: (prev: T | undefined) => T | PromiseLike<T>,
  options?: MemoOptions,
): Memo<T> {
  const read: Accessor<T> = scopedMemo(fn, options) ?? createMemo(fn);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return read as Memo<T>;
}

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

/** `action` が返す関数。 */
export type Action<Args extends unknown[], R> = ((...args: Args) => Promise<R>) & {
  /** この action の呼び出しが実行中かどうかを返す。 */
  pending(): boolean;
};

type ActionBody<Args extends unknown[], R> = (
  ...args: Args
) => Promise<R> | Generator<unknown, R, unknown>;

/**
 * 1 つのトランザクションとして実行する書き込みを作成する。
 * async 関数では、最初の `await` より前の書き込みが action の終わりまで保留される。
 * generator では、`yield` の後の書き込みも保留される。同時に呼び出した action は、すべてが終わったときに一緒に終わる。
 */
export function action<Args extends unknown[], R>(fn: ActionBody<Args, R>): Action<Args, R> {
  const [pending, setPending] = createOptimistic(false);
  const run = solidAction(function* (...args: Args): Generator<unknown, R, R> {
    setPending(true);
    const result = fn(...args);
    if (result instanceof Promise) return yield result;
    return yield* result;
  });
  return Object.assign((...args: Args) => run(...args), { pending });
}

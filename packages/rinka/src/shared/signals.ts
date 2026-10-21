import {
  action as solidAction,
  createMemo,
  createOptimistic,
  createSignal,
  createTrackedEffect,
  isPending,
  refresh,
} from "@solidjs/signals";

/** 読み取りの関数と書き込みの関数の組を作成する。書き込んだ値は、flush されるまで読み取りに反映されない。 */
export const signal = createSignal;

/** ほかの signal や memo から計算する値を作成する。関数は Promise を返してもよい。 */
export const memo = createMemo;

/**
 * `fn` が読み取った値が変化するたびに、`fn` を再び実行する。
 * `fn` が返した後始末の関数は、次に `fn` を実行する前と、effect を破棄するときに呼ばれる。
 */
export function effect(fn: () => void | (() => void)): void {
  // oxlint-disable-next-line typescript/no-deprecated
  createTrackedEffect(fn);
}

/**
 * action の中で書き込むとすぐに反映され、action が終わると元の値に戻る値を作成する。
 * 関数を渡すと、action が終わった時点で関数が返す値に戻る。
 */
export const optimistic = createOptimistic;

export { isPending, refresh };

/** `action` が返す関数。 */
export type Action<Args extends unknown[], R> = ((...args: Args) => Promise<R>) & {
  /** この action の呼び出しが実行中かどうかを返す。 */
  pending(): boolean;
};

type ActionBody<Args extends unknown[], R> = (
  ...args: Args
) => Promise<R> | Generator<unknown, R, unknown> | AsyncGenerator<unknown, R, unknown>;

/**
 * 1 つのトランザクションとして実行する書き込みを作成する。
 * async 関数では、最初の `await` より前の書き込みが action の終わりまで保留される。
 * generator では、`yield` の後の書き込みも保留される。同時に呼び出した action は、すべてが終わったときに一緒に終わる。
 */
export function action<Args extends unknown[], R>(fn: ActionBody<Args, R>): Action<Args, R> {
  const [pending, setPending] = createOptimistic(false);
  const run = solidAction((...args: Args) => {
    setPending(true);
    const result = fn(...args);
    return result instanceof Promise ? wait(result) : result;
  });
  return Object.assign((...args: Args) => run(...args), { pending });
}

function* wait<R>(promise: Promise<R>): Generator<Promise<R>, R, R> {
  return yield promise;
}

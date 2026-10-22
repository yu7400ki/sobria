import { createMemo, type SourceAccessor } from "@solidjs/signals";

import { isPlainObject } from "../shared/objects.ts";
import { runSeeding, type ScopedMemo } from "../shared/scope.ts";
import { isChildKey, isReservedKey, PROPS_KEY } from "../shared/transfer-keys.ts";

/** 起動スクリプトが `window.$rinka` に定義する受け口のうち、値の引き継ぎで使用するものを表す。 */
interface Receiver {
  /** ホストの ID ごとに、引き継ぐ値をキーごとに保持する。 */
  readonly v: Record<string, Record<string, unknown> | undefined>;
  /** ホストの ID ごとに、値が届いたときに呼ぶ関数を保持する。 */
  readonly l: Record<string, (() => void)[] | undefined>;
  /** 値が無いことを表すオブジェクトである。 */
  readonly n: object;
  /** インスタンスの起動の条件を満たした時点で `start` を呼ぶ。 */
  readonly w: (host: Element, start: () => void) => void;
}

declare global {
  /** 起動スクリプトが定義する受け口である。起動スクリプトを読み込んでいないページでは `undefined` である。 */
  var $rinka: Receiver | undefined;
}

/** `window.$rinka` を返す。起動スクリプトを読み込んでいなければ `undefined` を返す。 */
const receiver = (): Receiver | undefined => globalThis.$rinka;

/** 起動スクリプトが `host` の起動の条件を満たしたと通知した時点で、`start` を呼ぶ。起動スクリプトを読み込んでいないページでは、すぐに呼ぶ。 */
export function whenStartable(host: Element, start: () => void): void {
  const store = receiver();
  if (store) store.w(host, start);
  else start();
}

/** ホストが起動の前に待つ、`data-om` のキーを返す。 */
function waitedKeys(host: Element): string[] {
  return (host.getAttribute("data-om") ?? "").split(" ").filter(Boolean);
}

/**
 * ホストと、ホストの Shadow DOM の中で `@c:キー` の値が指す子要素のホストを、子孫まで含めて、`[ホスト, ID]` の組で返す。
 */
function related(host: Element, id: string): [Element, string][] {
  const found: [Element, string][] = [[host, id]];
  for (const [key, child] of Object.entries(receiver()?.v[id] ?? {})) {
    if (!isChildKey(key) || typeof child !== "string") continue;
    const el = host.shadowRoot?.querySelector(`[data-oh="${child}"]`);
    if (el) found.push(...related(el, child));
  }
  return found;
}

/** ホストと、値を引き継ぐ子要素のホストが待つキーの値が、すべて届いているかどうかを返す。 */
function arrived(host: Element, id: string): boolean {
  return related(host, id).every(([el, target]) => {
    const values = receiver()?.v[target] ?? {};
    return waitedKeys(el).every((key) => Object.hasOwn(values, key));
  });
}

/**
 * SSR したホストと、値を引き継ぐ子要素のホストが待つキーの値が、すべて届いていれば `undefined` を返す。
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
  const watched = new Set<string>();
  const watch = () => {
    for (const [, target] of related(host, id)) {
      if (watched.has(target)) continue;
      watched.add(target);
      (store.l[target] ??= []).push(listener);
    }
  };
  const listener = () => {
    if (!arrived(host, id)) {
      watch();
      return;
    }
    cancel();
    ready();
  };
  const cancel = () => {
    for (const target of watched) {
      const listeners = store.l[target] ?? [];
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    }
    watched.clear();
  };
  watch();
  return cancel;
}

/** サーバーから引き継いだ値と、その値を使用する関数を表す。 */
export interface Transferred {
  /** 引き継いだ値のうち、値が無いことを表すオブジェクトを除いたものを、キーごとに保持する。 */
  readonly values: ReadonlyMap<string, unknown>;
  /** 引き継いだ、属性にできない props の値を、props の名前ごとに保持する。 */
  readonly props: object;
  /** キーの値を引き継いでいれば、その値を最初の値にする memo を作成し、引き継いでいなければ memo を作成する。 */
  readonly memo: ScopedMemo;
  /** 開発時に、引き継いだ memo の値のうち、`memo` で使用しなかったものを警告する。 */
  readonly finish: () => void;
}

/** ホストの ID が `id` の SSR したホストから、`<tag>` の要素に値を引き継ぐ。`id` が `null` なら、引き継ぐ値を空にする。 */
export function beginTakeover(id: string | null, tag: string): Transferred {
  const store = receiver();
  const values = new Map<string, unknown>();
  if (id !== null) {
    for (const [key, value] of Object.entries(store?.v[id] ?? {})) {
      if (value !== store?.n) values.set(key, value);
    }
  }
  const passed = values.get(PROPS_KEY);
  const used = new Set<string>();
  return {
    values,
    props: isPlainObject(passed) ? passed : {},
    memo: <T>(key: string, compute: (prev: T | undefined) => T | PromiseLike<T>) => {
      if (!values.has(key)) return createMemo(compute);
      used.add(key);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return seededMemo(values.get(key) as T, compute);
    },
    finish: () => {
      if (!import.meta.env?.DEV) return;
      const unused = [...values.keys()].filter((key) => !isReservedKey(key) && !used.has(key));
      if (unused.length > 0) {
        console.warn(
          `[rinka] <${tag}> は、サーバーから引き継いだ memo の値 ${unused.join(", ")} を使用しませんでした。サーバーとクライアントで描画が異なる可能性があります。`,
        );
      }
    },
  };
}

/**
 * 引き継いだ `value` を最初の値にする memo を作成する。最初の計算では、`compute` に直前の値として `undefined` を渡してシードとして 1 回呼び、
 * 戻り値と、投げた値を使用しない。2 回目以降の計算では、`compute` の戻り値を使用する。
 */
function seededMemo<T>(
  value: T,
  compute: (prev: T | undefined) => T | PromiseLike<T>,
): SourceAccessor<T> {
  let seeding = true;
  return createMemo<T>((prev) => {
    if (!seeding) return compute(prev);
    seeding = false;
    let result: unknown;
    try {
      result = runSeeding(() => compute(undefined));
    } catch {
      return value;
    }
    void Promise.resolve(result).catch(() => {});
    return value;
  });
}

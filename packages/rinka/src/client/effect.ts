import { createTrackedEffect } from "@solidjs/signals";

/**
 * `fn` が読み取った値が変化するたびに、`fn` を再び実行する。
 * `fn` が返した後始末の関数は、次に `fn` を実行する前と、effect を破棄するときに呼ばれる。
 */
export function effect(fn: () => void | (() => void)): void {
  // oxlint-disable-next-line typescript/no-deprecated
  createTrackedEffect(fn);
}

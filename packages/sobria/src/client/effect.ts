import { createEffect } from "@solidjs/signals";

import type { Effect } from "../shared/signals.ts";

/**
 * `read` が読み取った値が変化するたびに、`read` の戻り値を `apply` に渡して呼ぶ。
 * `read` が非同期の memo を読むときは、memo が解決してから `apply` を呼ぶ。
 * `apply` が返した後始末の関数は、次に `apply` を呼ぶ前と、effect を破棄するときに呼ばれる。
 */
export const effect: Effect = (read, apply) => {
  createEffect(read, (value) => apply(value));
};

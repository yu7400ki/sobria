import { createEffect, createSignal, untrack } from "@solidjs/signals";

import type { External } from "../shared/signals.ts";
import { isHydrating } from "./hydration.ts";

/**
 * 外部の状態を読み取る関数を返す。SSR した要素が起動するときは `getServerSnapshot` の値を最初の値にし、起動した後に `getSnapshot` の値に切り替える。それ以外では、最初から `getSnapshot` の値を使用する。
 * `subscribe` の通知を受けるたびに、`getSnapshot` で値を読み直す。作成した要素やコンポーネントが破棄されると、購読を解除する。
 */
export const external: External = (subscribe, getSnapshot, getServerSnapshot) => {
  const first = untrack(() =>
    getServerSnapshot && isHydrating() ? getServerSnapshot() : getSnapshot(),
  );
  const [box, setBox] = createSignal(
    { value: first },
    { equals: (a, b) => Object.is(a.value, b.value) },
  );
  const update = () => setBox({ value: getSnapshot() });
  createEffect(
    () => undefined,
    () => {
      const unsubscribe = subscribe(update);
      update();
      return unsubscribe;
    },
  );
  return () => box().value;
};

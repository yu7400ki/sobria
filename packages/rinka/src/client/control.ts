import { createErrorBoundary, createLoadingBoundary } from "@solidjs/signals";

import type { NavigationProps } from "../shared/navigation.ts";
import type { ClientNode } from "../shared/nodes.ts";
import { isFunction } from "../shared/objects.ts";
import { asClientNode, build, DeferredRegion, type Child } from "./dom.ts";
import { withHydrating } from "./hydration.ts";

/** 関数で渡された内容は、境界の中で呼び出して評価する。 */
const read = (value: Child): Child => (isFunction(value) ? value() : value);

/** 内側の非同期の値が初めて解決するまで、`fallback` を表示する。 */
export function Loading(props: { fallback?: Child; children?: Child }): ClientNode {
  return asClientNode(
    new DeferredRegion(
      (at) =>
        createLoadingBoundary(
          () => build(read(props.children), at),
          () => read(props.fallback),
        ),
      "loading",
    ),
  );
}

/**
 * 内側で投げられたエラーを受け止めて、`fallback` を表示する。
 * `fallback` に関数を渡すと、その関数はエラーと、内側を作り直す `retry` を受け取る。
 * `status` は、サーバーで描画するときに、シェルの中で受け止めたときのレスポンスのステータスになる。
 */
export function Errored(props: {
  fallback: Child | ((error: unknown, retry: () => void) => Child);
  children?: Child;
  status?: number;
}): ClientNode {
  return asClientNode(
    new DeferredRegion(
      (at) =>
        createErrorBoundary(
          () => build(read(props.children), at),
          // フォールバックは SSR のノードを引き取らずに表示する
          (error, retry) =>
            withHydrating(false, () => {
              const { fallback } = props;
              return typeof fallback === "function" ? fallback(error(), retry) : fallback;
            }),
        ),
      "errored",
    ),
  );
}

/** 何も描画しない。 */
export function Navigation(_props: NavigationProps): ClientNode {
  return asClientNode(null);
}

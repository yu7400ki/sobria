import { createErrorBoundary, createLoadingBoundary, mapArray } from "@solidjs/signals";

import type { ForProps } from "../shared/for.ts";
import type { ClientChild } from "../shared/jsx-types.ts";
import type { NavigationProps } from "../shared/navigation.ts";
import type { ClientNode, SharedNode } from "../shared/nodes.ts";
import { isFunction } from "../shared/objects.ts";
import { asClientNode, asSharedNode, build, buildAt, DeferredRegion, type Child } from "./dom.ts";
import { withHydrating } from "./hydration.ts";

/** 関数で渡された内容は、境界の中で呼び出して評価する。 */
const read = (value: Child): Child => (isFunction(value) ? value() : value);

/** 内側の非同期の値が初めて解決するまで、`fallback` を表示する。 */
export function Loading(props: { fallback?: Child; children?: Child }): ClientNode {
  return asClientNode(
    new DeferredRegion(
      (at, ns, place) =>
        createLoadingBoundary(
          () => build(read(props.children), at, ns, place),
          () => read(props.fallback),
        ),
      "keep",
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
      (at, ns, place) =>
        createErrorBoundary(
          () => build(read(props.children), at, ns, place),
          // フォールバックは SSR のノードを引き取らずに表示する
          (error, retry) =>
            withHydrating(false, () => {
              const { fallback } = props;
              return typeof fallback === "function" ? fallback(error(), retry) : fallback;
            }),
        ),
      "replace",
    ),
  );
}

/**
 * `each` の項目ごとに `children` が返した内容を、項目の順に描画する。`children` は、項目が配列に加わったときに 1 回だけ呼び、
 * 配列が変化しても、残った項目の内容は作成し直さない。項目は値の同一性で対応付ける。
 */
export function For<T>(props: ForProps<T, ClientChild>): SharedNode {
  return asSharedNode(
    new DeferredRegion((at, ns, place) => {
      const items = mapArray(
        () => props.each,
        (item, index) => buildAt(props.children(item, index), at, ns, place),
      );
      return () => items().flat();
    }, "replace"),
  );
}

/** 何も描画しない。 */
export function Navigation(_props: NavigationProps): ClientNode {
  return asClientNode(null);
}

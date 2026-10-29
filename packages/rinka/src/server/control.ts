import type { ForProps } from "../shared/for.ts";
import type { ServerChild } from "../shared/jsx-types.ts";
import type { NavigationProps } from "../shared/navigation.ts";
import type { ServerNode, SharedNode } from "../shared/nodes.ts";
import { isFunction } from "../shared/objects.ts";
import { asNode, asServerNode, type Node } from "./tree.ts";

/** 関数で渡された内容は、呼び出した値にする。 */
const read = (value: unknown): Node => asNode(isFunction(value) ? value() : value);

/** 内側が保留中であれば、`fallback` を先に送り、中身を後から送る。 */
export function Loading(props: { fallback?: unknown; children?: unknown }): ServerNode {
  return asServerNode({
    kind: "loading",
    fallback: () => read(props.fallback),
    children: () => read(props.children),
  });
}

/**
 * 内側で投げられたエラーを受け止めて、`fallback` を出力する。`fallback` に関数を渡すと、その関数はエラーを受け取る。
 * シェルの中で受け止めたときのレスポンスのステータスは、`status` で指定する。
 */
export function Errored(props: {
  fallback: Exclude<ServerChild, Function> | ((error: unknown) => ServerChild);
  children?: unknown;
  status?: number;
}): ServerNode {
  return asServerNode({
    kind: "errored",
    fallback: (error) => {
      const { fallback } = props;
      return asNode(isFunction(fallback) ? fallback(error) : fallback);
    },
    children: () => read(props.children),
    status: props.status,
  });
}

/** `each` の項目ごとに `children` が返した内容を、項目の順に出力する。`children` は、項目と、項目の位置を返す関数を受け取る。 */
export function For<T>(props: ForProps<T, ServerChild>): SharedNode {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return asServerNode(() =>
    asNode((props.each ?? []).map((item, index) => props.children(item, () => index))),
  ) as unknown as SharedNode;
}

/** ページの遷移の設定を、文書の `<head>` に出力する。 */
export function Navigation(props: NavigationProps): ServerNode {
  return asServerNode({ kind: "navigation", props });
}

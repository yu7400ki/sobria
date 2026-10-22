import type { ServerNode } from "../shared/nodes.ts";
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
  fallback: unknown;
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

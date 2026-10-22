import type { ServerNode } from "../shared/nodes.ts";
import { asNode, asServerNode, createNode } from "./tree.ts";

/** JSX のタグから、サーバーで描画する木のノードを作成する。 */
export function jsx(
  type: string | ((...args: never[]) => unknown),
  props: object,
  key?: string,
): ServerNode {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return asServerNode(createNode(type as never, props as Record<string, unknown>, key));
}

export { jsx as jsxs };

/** 子をそのまま返す。 */
export function Fragment(props: { children?: unknown }): ServerNode {
  return asServerNode(asNode(props.children));
}

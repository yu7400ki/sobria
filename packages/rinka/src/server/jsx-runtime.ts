import { isElementComponent } from "../shared/element.ts";
import type { ServerNode } from "../shared/nodes.ts";
import { scopedChild } from "../shared/scope.ts";
import { asNode, asServerNode, createNode } from "./tree.ts";

/** JSX のタグから、サーバーで描画する木のノードを作成する。`site` は、要素を作成する呼び出し箇所の ID である。 */
export function jsx(
  type: string | ((...args: never[]) => unknown),
  props: object,
  key?: string,
  site?: string,
): ServerNode {
  const child = isElementComponent(type) ? scopedChild(site) : undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return asServerNode(createNode(type as never, props as Record<string, unknown>, key, child));
}

export { jsx as jsxs };

/** 子をそのまま返す。 */
export function Fragment(props: { children?: unknown }): ServerNode {
  return asServerNode(asNode(props.children));
}

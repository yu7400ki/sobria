import { isElementComponent, type ElementComponent } from "../shared/element.ts";
import type { ClientNode } from "../shared/nodes.ts";
import { createNode, type Child, type Component } from "./dom.ts";
import { createElementInstance } from "./element.ts";

/** JSX の要素を作成する。要素コンポーネントはインスタンスを作成し、ほかの型は DOM のノードを作成する。 */
export function jsx<P, M extends object>(
  type: ElementComponent<P, M>,
  props: Record<string, unknown>,
  key?: string,
): ClientNode;
export function jsx<P>(type: Component<P>, props: P, key?: string): ClientNode;
export function jsx(type: string, props: Record<string, unknown>, key?: string): ClientNode;
export function jsx(
  type: string | Component<Record<string, unknown>> | ElementComponent<unknown>,
  props: Record<string, unknown>,
  key?: string,
): ClientNode {
  if (isElementComponent(type)) return createElementInstance(type, props, key);
  return createNode(type, props, key);
}

export { jsx as jsxs };

/** 子をそのまま返す。 */
export function Fragment(props: { children?: Child }): ClientNode {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return props.children as ClientNode;
}

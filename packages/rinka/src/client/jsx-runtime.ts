import { isElementComponent, type ElementComponent } from "../shared/element.ts";
import type { ClientNode } from "../shared/nodes.ts";
import { asClientNode, createNode, type Child, type Component } from "./dom.ts";
import { createElementInstance } from "./element.ts";

/**
 * JSX の要素を作成する。要素コンポーネントはインスタンスを作成し、ほかの型は DOM のノードを作成する。
 * `site` は、要素を作成する呼び出し箇所の ID である。
 */
export function jsx<P, M extends object>(
  type: ElementComponent<P, M>,
  props: Record<string, unknown>,
  key?: string,
  site?: string,
): ClientNode;
export function jsx<P>(type: Component<P>, props: P, key?: string): ClientNode;
export function jsx(type: string, props: Record<string, unknown>, key?: string): ClientNode;
export function jsx(
  type: string | Component<Record<string, unknown>> | ElementComponent<unknown>,
  props: Record<string, unknown>,
  key?: string,
  site?: string,
): ClientNode {
  if (isElementComponent(type)) return createElementInstance(type, props, key, site);
  return createNode(type, props, key);
}

export { jsx as jsxs };

/** 子をそのまま返す。 */
export function Fragment(props: { children?: Child }): ClientNode {
  return asClientNode(props.children);
}

import { isElementComponent, type ElementComponent } from "../shared/element.ts";
import type {
  ChildrenAttribute,
  ClientChild,
  HtmlTag,
  IntrinsicElementsOf,
  KeyAttribute,
} from "../shared/jsx-types.ts";
import type { ClientNode } from "../shared/nodes.ts";
import { asClientNode, createNode, type Child, type Component } from "./dom.ts";
import { createElementInstance } from "./element.ts";
import type { EventHandlers } from "./jsx-events.ts";

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

/** 要素の JSX のネイティブのタグが、属性に加えて受け付ける props を表す。 */
type ClientExtras = {
  [K in HtmlTag]: EventHandlers<HTMLElementTagNameMap[K]> & {
    ref?: (el: HTMLElementTagNameMap[K]) => unknown;
  };
};

/** 要素のファイルの JSX の型を表す。 */
export declare namespace JSX {
  type Element = ClientNode;
  type ElementType = string | ((props: never, ctx: never) => ClientNode);
  interface ElementChildrenAttribute extends ChildrenAttribute {}
  interface IntrinsicAttributes extends KeyAttribute {}
  interface IntrinsicElements extends IntrinsicElementsOf<ClientChild, ClientExtras> {}
}

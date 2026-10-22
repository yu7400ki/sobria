import {
  isElementComponent,
  type ElementComponent,
  type ElementBrand,
  type ElementRef,
} from "../shared/element.ts";
import type { SvgTag } from "../shared/jsx-attributes.ts";
import type { EventHandlers } from "../shared/jsx-events.ts";
import type {
  ChildrenAttribute,
  ClientChild,
  HtmlTag,
  IntrinsicElementsOf,
  KeyAttribute,
  ManagedAttributes,
} from "../shared/jsx-types.ts";
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

/** DOM の要素 `E` を受け取る `ref` と、`E` のイベントハンドラーを表す。 */
type DomProps<E extends Element> = EventHandlers<E> & { ref?: (el: E) => unknown };

/** 要素の JSX のネイティブのタグが、属性に加えて受け付ける props を表す。 */
type ClientExtras = { [K in HtmlTag]: DomProps<HTMLElementTagNameMap[K]> } & {
  [K in SvgTag]: DomProps<SVGElementTagNameMap[K]>;
};

/**
 * 要素の JSX で、要素と補助コンポーネントが Props とホストの属性に加えて受け付ける props を表す。
 * 要素は、`ElementRef` を受け取る `ref` と、Props に宣言していない名前のイベントハンドラーを受け付ける。
 */
type ClientHost<C, P> = (C extends ElementBrand
  ? { ref?: (el: ElementRef<C>) => unknown } & Omit<EventHandlers<ElementRef<C>>, keyof P>
  : unknown) & {
  readonly [
    load: `load:${string}`
  ]: "load:* は、サーバーのファイルでだけ記述できます。要素の起動のタイミングは、要素を配置したページで指定してください。";
};

/** 要素のファイルの JSX の型を表す。 */
export declare namespace JSX {
  type Element = ClientNode;
  type ElementType = string | ((props: never, ctx: never) => ClientNode);
  interface ElementChildrenAttribute extends ChildrenAttribute {}
  interface IntrinsicAttributes extends KeyAttribute {}
  interface IntrinsicElements extends IntrinsicElementsOf<
    ClientChild,
    ClientExtras,
    DomProps<HTMLElement>
  > {}
  type LibraryManagedAttributes<C, P> = ManagedAttributes<C, P, ClientHost<C, P>>;
}

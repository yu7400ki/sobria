import { isElementComponent, type ElementBrand } from "../shared/element.ts";
import type {
  ChildrenAttribute,
  ElementOnlyExtras,
  ElementOnlyLoose,
  ElementOnlyRef,
  IntrinsicElementsOf,
  KeyAttribute,
  ManagedAttributes,
  ServerChild,
} from "../shared/jsx-types.ts";
import type { ClientNode, ServerNode } from "../shared/nodes.ts";
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

/** サーバーの JSX で、要素が Props とホストの属性に加えて受け付ける、起動のタイミングの props を表す。 */
interface LoadAttributes {
  "load:load"?: true;
  "load:idle"?: true;
  "load:visible"?: true;
  "load:media"?: string;
}

/** サーバーの JSX で、要素と補助コンポーネントが Props とホストの属性に加えて受け付ける props を表す。 */
type ServerHost<C> = ElementOnlyRef & (C extends ElementBrand ? LoadAttributes : unknown);

/** サーバーのファイルの JSX の型を表す。 */
export declare namespace JSX {
  type Element = ServerNode;
  type ElementType =
    | string
    | ((props: never, ctx: never) => ServerNode | ClientNode | Promise<ServerNode>);
  interface ElementChildrenAttribute extends ChildrenAttribute {}
  interface IntrinsicAttributes extends KeyAttribute {}
  interface IntrinsicElements extends IntrinsicElementsOf<
    ServerChild,
    ElementOnlyExtras,
    ElementOnlyLoose
  > {}
  type LibraryManagedAttributes<C, P> = ManagedAttributes<C, P, ServerHost<C>>;
}

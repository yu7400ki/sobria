import type {
  ChildrenAttribute,
  ElementOnlyExtras,
  ElementOnlyLoose,
  IntrinsicElementsOf,
  KeyAttribute,
  ManagedAttributes,
  SharedChild,
} from "./jsx-types.ts";
import type { SharedNode } from "./nodes.ts";

/** 共通のコンポーネントの JSX の要素を作成する。要素の中ではブラウザで、ページの中ではサーバーで描画する。 */
export declare function jsx(
  type: unknown,
  props: Record<string, unknown>,
  key?: string,
): SharedNode;

/** 子の配列を受け取る `jsx` である。 */
export declare const jsxs: typeof jsx;

/** 子をそのまま返す。 */
export declare function Fragment(props: { children?: unknown }): SharedNode;

/** 共通のコンポーネントの JSX の型を表す。 */
export declare namespace JSX {
  type Element = SharedNode;
  type ElementType = string | ((props: never, ctx: never) => SharedNode);
  interface ElementChildrenAttribute extends ChildrenAttribute {}
  interface IntrinsicAttributes extends KeyAttribute {}
  interface IntrinsicElements extends IntrinsicElementsOf<
    SharedChild,
    ElementOnlyExtras,
    ElementOnlyLoose
  > {}
  type LibraryManagedAttributes<C, P> = ManagedAttributes<C, P, unknown>;
}

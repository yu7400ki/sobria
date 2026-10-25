import type { NavigationProps } from "../shared/navigation.ts";
import { serverJsxNodes, type ServerNode } from "../shared/nodes.ts";
import type { ScopedChild } from "../shared/scope.ts";

/** サーバーで描画する木のノードを表す。関数は、描画するときに呼び出して、返した値を描画する。 */
export type Node =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly Node[]
  | (() => Node)
  | TagNode
  | ComponentNode
  | LoadingNode
  | ErroredNode
  | DepthNode
  | NavigationNode;

/** ネイティブのタグを表す。`props` は、記述子のまま保持する。 */
export interface TagNode {
  readonly kind: "tag";
  readonly tag: string;
  readonly props: Record<string, unknown>;
  readonly key: string | undefined;
}

/** コンポーネントの呼び出しを表す。 */
export interface ComponentNode {
  readonly kind: "component";
  readonly fn: (props: Record<string, unknown>) => unknown;
  readonly props: Record<string, unknown>;
  readonly key: string | undefined;
  /** 要素の描画の範囲の中で、呼び出し箇所を指定して作成した要素なら、作成した範囲とキーを表す。 */
  readonly child?: ScopedChild;
}

/** `<Loading>` を表す。 */
export interface LoadingNode {
  readonly kind: "loading";
  readonly fallback: () => Node;
  readonly children: () => Node;
}

/** `<Errored>` を表す。 */
export interface ErroredNode {
  readonly kind: "errored";
  readonly fallback: (error: unknown) => Node;
  readonly children: () => Node;
  readonly status: number | undefined;
}

/** ルートのファイルの深さを、子の描画に伝えるノードを表す。 */
export interface DepthNode {
  readonly kind: "depth";
  readonly depth: number;
  readonly children: unknown;
}

/** `<Navigation>` を表す。 */
export interface NavigationNode {
  readonly kind: "navigation";
  readonly props: NavigationProps;
}

/** `children` を、ルートのファイルの深さ `depth` で描画するノードを返す。 */
export const withDepth = (depth: number, children: unknown): Node => ({
  kind: "depth",
  depth,
  children,
});

/** 木のノードを、`ServerNode` の型として扱う。 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
export const asServerNode = (node: Node): ServerNode => node as unknown as ServerNode;

/** `ServerNode` の型の値を、木のノードとして扱う。 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
export const asNode = (value: unknown): Node => value as Node;

/** タグ名かコンポーネントと props から、木のノードを作成する。 */
export function createNode(
  type: string | ((props: Record<string, unknown>) => unknown),
  props: Record<string, unknown>,
  key?: string,
  child?: ScopedChild,
): Node {
  const node: TagNode | ComponentNode =
    typeof type === "string"
      ? { kind: "tag", tag: type, props, key }
      : child
        ? { kind: "component", fn: type, props, key, child }
        : { kind: "component", fn: type, props, key };
  serverJsxNodes.add(node);
  return node;
}

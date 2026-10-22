import type { ServerNode } from "../shared/nodes.ts";

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
  | ErroredNode;

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
): Node {
  return typeof type === "string"
    ? { kind: "tag", tag: type, props, key }
    : { kind: "component", fn: type, props, key };
}

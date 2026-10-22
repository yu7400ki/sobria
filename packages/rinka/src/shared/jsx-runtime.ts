import type { ClientNode, ServerNode } from "./nodes.ts";

/** 共通のコンポーネントの JSX の要素を作成する。要素の中ではブラウザで、ページの中ではサーバーで描画する。 */
export declare function jsx(
  type: unknown,
  props: Record<string, unknown>,
  key?: string,
): ClientNode & ServerNode;

/** 子の配列を受け取る `jsx` である。 */
export declare const jsxs: typeof jsx;

/** 子をそのまま返す。 */
export declare function Fragment(props: { children?: unknown }): ClientNode & ServerNode;

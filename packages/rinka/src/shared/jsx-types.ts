import type { LooseAttributes, NativeAttributes, SvgTag } from "./jsx-attributes.ts";
import type { ClientNode, ServerNode } from "./nodes.ts";

/** HTML のタグの名前を表す。 */
export type HtmlTag = keyof HTMLElementTagNameMap;

/**
 * ネイティブのタグの JSX の型を作成する。HTML のタグは、属性と、子の型 `C` の `children` と、タグごとの `X[K]` を受け付ける。
 * SVG のタグと、名前に `-` を含むタグは、属性の名前を検査しない。
 */
export type IntrinsicElementsOf<C, X extends Record<HtmlTag, object>> = {
  [K in HtmlTag]: NativeAttributes<K> & X[K] & { children?: C };
} & { [K in SvgTag]: LooseAttributes } & { [tag: `${string}-${string}`]: LooseAttributes };

/** タグごとに追加する props が無いことを表す。 */
export type NoExtras = Record<HtmlTag, object>;

/** JSX の要素に記述できる `key` を表す。 */
export interface KeyAttribute {
  key?: string | number;
}

/** JSX で `children` を子として扱うことを表す。 */
export interface ChildrenAttribute {
  children: unknown;
}

/** 要素の JSX の子に記述できる値を表す。 */
export type ClientChild =
  | ClientNode
  | Node
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | readonly ClientChild[]
  | (() => ClientChild);

/** サーバーの JSX の子に記述できる値を表す。 */
export type ServerChild =
  | ServerNode
  | ClientNode
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | readonly ServerChild[]
  | (() => ServerChild);

/** 共通のコンポーネントの JSX の子に記述できる値を表す。 */
export type SharedChild =
  | (ClientNode & ServerNode)
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | readonly SharedChild[]
  | (() => SharedChild);

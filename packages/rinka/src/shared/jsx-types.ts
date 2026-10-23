import type { AttributeType, formAttributeTypes } from "./element.ts";
import type {
  GlobalAttributes,
  LooseAttributes,
  NativeAttributes,
  SvgTag,
} from "./jsx-attributes.ts";
import type { EventPropName } from "./names.ts";
import type { ClientNode, ServerNode, Slot, SlotContent } from "./nodes.ts";

/** HTML のタグの名前を表す。 */
export type HtmlTag = keyof HTMLElementTagNameMap;

/** HTML と SVG のタグの名前を表す。 */
type NativeTag = HtmlTag | SvgTag;

/**
 * ネイティブのタグの JSX の型を作成する。HTML のタグは、属性と、子の型 `C` の `children` と、タグごとの `X[K]` を受け付ける。
 * SVG のタグは `X[K]` を、名前に `-` を含むタグは `U` を受け付け、ほかの属性の名前を検査しない。
 */
export type IntrinsicElementsOf<C, X extends Record<NativeTag, object>, U extends object> = {
  [K in HtmlTag]: NativeAttributes<K> & X[K] & { children?: C };
} & { [K in SvgTag]: LooseAttributes & X[K] } & {
  [tag: `${string}-${string}`]: LooseAttributes & U;
};

/** `ref` の型を、要素のファイルでだけ記述できることを示すメッセージの型にする。 */
export interface ElementOnlyRef {
  ref?: "ref は、要素のファイルでだけ使用できます。";
}

/** 属性の名前を検査しないタグで、`ref` と、`on` と英字の大文字で始まる名前の型を、要素のファイルでだけ記述できることを示すメッセージの型にする。 */
export type ElementOnlyLoose = ElementOnlyRef & {
  readonly [handler: EventPropName]: "イベントハンドラーは、要素のファイルでだけ使用できます。";
};

/** 要素のファイルの外の JSX で、HTML と SVG のタグの `ref` と、SVG のタグのイベントハンドラーを型エラーにする型を表す。 */
export type ElementOnlyExtras = Record<HtmlTag, ElementOnlyRef> & Record<SvgTag, ElementOnlyLoose>;

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

/** `Slot` の型を、要素とサーバーの JSX の両方の内容を受け付ける `SlotContent` にする。 */
type SlotValue<T> = T extends Slot ? SlotContent : T;

/** Props の型 `P` のうち、`Slot` の型の props を、`SlotContent` を受け付ける型にする。 */
export type AcceptSlots<P> = { [K in keyof P]: SlotValue<P[K]> };

/** コンポーネント `C` の戻り値の型を表す。async 関数のコンポーネントは、Promise が解決する値の型を表す。 */
type Rendered<C> = C extends (...args: never[]) => infer R ? Awaited<R> : never;

/** 要素が、Props の型に記述していなくても受け付ける、フォームの部品の `name` と `disabled` を表す。Props の型に同じ名前があれば、Props の型を使用する。 */
type FormAttributes<P> = Omit<
  {
    -readonly [
      K in keyof typeof formAttributeTypes
    ]?: AttributeTypeValue[(typeof formAttributeTypes)[K]];
  },
  keyof P
>;

/** `AttributeType` の名前ごとに、その値の型を表す。 */
interface AttributeTypeValue extends Record<AttributeType, unknown> {
  string: string;
  number: number;
  boolean: boolean;
}

/**
 * JSX の名前空間の `LibraryManagedAttributes` を表す。
 * 戻り値が `ServerNode` に代入できるコンポーネントは、Props だけを受け付ける。
 * 戻り値が `ClientNode` に代入できるコンポーネントは、Props に加えて、フォームの部品の `name` と `disabled`、ホストの属性、`Host` を受け付ける。
 */
export type ManagedAttributes<C, P, Host> = [Rendered<C>] extends [ServerNode]
  ? AcceptSlots<P>
  : [Rendered<C>] extends [ClientNode]
    ? AcceptSlots<P> & FormAttributes<P> & GlobalAttributes & Host
    : P;

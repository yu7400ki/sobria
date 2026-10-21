import type { ClientNode } from "./nodes.ts";

/** 属性の値から変換する props の型を表す。 */
export type AttributeType = "string" | "number" | "boolean";

/** `defineElement` の 3 つ目の引数を表す。 */
export interface ElementOptions {
  /** 受け付ける props の名前の一覧。 */
  readonly props: readonly string[];
  /** 属性から変換する props の型。記述しない props は、属性の値を文字列のまま受け取る。 */
  readonly types?: Readonly<Record<string, AttributeType>>;
  /** Props の型でスロットとして宣言した props の名前の一覧。`children` は含めない。 */
  readonly slots?: readonly string[];
  /** Props の型で関数として宣言した props の名前の一覧。 */
  readonly functionProps?: readonly string[];
}

/** 要素の関数が 2 番目の引数で受け取る、ホストに依存する能力を表す。 */
export interface Ctx<M extends object = object> {
  /** ホストの要素。 */
  readonly host: HTMLElement;
  /** 要素が DOM に接続され、最初の内容を Shadow DOM に表示した後に呼ぶ関数を登録する。 */
  readonly onMount: (fn: () => void) => void;
  /** `members` の各プロパティを、その記述子のままホストに追加する。 */
  readonly expose: (members: M) => void;
}

/** 要素コンポーネントに要素の情報を付与するときの、プロパティのキーを表す。 */
export const elementInfo = Symbol.for("rinka.element");

/** 要素のタグ名と、`defineElement` に渡したオプションを表す。 */
export interface ElementInfo {
  readonly tag: string;
  readonly options: ElementOptions;
}

/** `defineElement` が返す要素コンポーネントを表す。 */
export type ElementComponent<P, M extends object = object> = ((
  props: P,
  ctx: Ctx<M>,
) => ClientNode) & { readonly [elementInfo]: ElementInfo };

/** `value` が `defineElement` の返した要素コンポーネントかどうかを返す。 */
export const isElementComponent = (value: unknown): value is ElementComponent<unknown> =>
  typeof value === "function" && elementInfo in value;

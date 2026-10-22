import type { ClientNode, Slot } from "./nodes.ts";

/** 属性の値から変換する props の型を表す。 */
export type AttributeType = "string" | "number" | "boolean";

/** `defineElement` の 3 つ目の引数を表す。 */
export interface ElementOptions {
  /** 受け付ける props の名前の一覧。 */
  readonly props: readonly string[];
  /** 属性から変換する props の型。記述しない props は、属性の値を文字列のまま受け取る。 */
  readonly types?: Readonly<Record<string, AttributeType>>;
  /** Props の型でスロットとして宣言した、`children` 以外の props の名前の一覧。 */
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

/** `defineElement` が要素コンポーネントに付与する、要素であることを示す型の印（ブランド）を表す。 */
export interface ElementBrand {
  readonly [elementInfo]: ElementInfo;
}

/** `defineElement` が返す要素コンポーネントを表す。 */
export type ElementComponent<P, M extends object = object> = ((
  props: P,
  ctx: Ctx<M>,
) => ClientNode) &
  ElementBrand;

/** `value` が `defineElement` の返した要素コンポーネントかどうかを返す。 */
export const isElementComponent = (value: unknown): value is ElementComponent<unknown> =>
  typeof value === "function" && elementInfo in value;

/** Props の型 `P` のうち、スロットになる props（`children` と、型が `Slot` の props）の名前を表す。型が `any` の props は含めない。 */
type SlotKeys<P> = {
  [K in keyof P]-?: K extends "children"
    ? K
    : 0 extends 1 & P[K]
      ? never
      : NonNullable<P[K]> extends Slot
        ? K
        : never;
}[keyof P];

/**
 * 要素コンポーネント `C` のインスタンスの型を表す。
 * `ctx.expose` で公開したメンバーと、スロットになる props を除いた props を持つ。
 * 公開したメンバーと同じ名前の `HTMLElement` のメンバーは、公開した側の型になる。
 */
export type ElementRef<C> =
  C extends ElementComponent<infer P, infer M>
    ? Omit<HTMLElement, keyof M> & M & Omit<P, SlotKeys<P>>
    : never;

/** `fn` に、タグ名と `defineElement` に渡したオプションを付与した要素コンポーネントを作成する。 */
export function createElementComponent<P, M extends object>(
  tag: string,
  fn: (props: P, ctx: Ctx<M>) => unknown,
  options: ElementOptions,
): ElementComponent<P, M> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const component = ((props: P, ctx: Ctx<M>) => fn(props, ctx)) as (
    props: P,
    ctx: Ctx<M>,
  ) => ClientNode;
  return Object.assign(component, { [elementInfo]: { tag, options } });
}

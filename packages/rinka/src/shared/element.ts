import type { defaultLoads } from "./names.ts";
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

/** 要素のファイルの `export const load` に記述できる、デフォルトの起動タイミングを表す。 */
export type DefaultLoad = (typeof defaultLoads)[number];

/** ブラウザが読み込む要素のモジュールの URL と、要素のデフォルトの起動タイミングを表す。 */
export interface Delivery {
  readonly module: string;
  readonly load: DefaultLoad;
}

/** 要素のタグ名と、`defineElement` に渡したオプションを表す。`delivery` は、Vite プラグインがコンパイルしたサーバー向けの要素だけが持つ。 */
export interface ElementInfo {
  readonly tag: string;
  readonly options: ElementOptions;
  readonly delivery?: Delivery;
}

/** `defineElement` が返す要素コンポーネントを表す。 */
export type ElementComponent<P, M extends object = object> = ((
  props: P,
  ctx: Ctx<M>,
) => ClientNode) & { readonly [elementInfo]: ElementInfo };

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
 * 要素の関数か要素コンポーネント `C` の、インスタンスの型を表す。
 * `ctx.expose` で公開したメンバーと、スロットになる props を除いた props を持つ。
 * 公開したメンバーと同じ名前の `HTMLElement` のメンバーは、公開した側の型になる。
 */
export type ElementRef<C> = C extends (props: infer P, ctx: Ctx<infer M>) => unknown
  ? Omit<HTMLElement, keyof M> & M & Omit<P, SlotKeys<P>>
  : never;

/** `fn` に、タグ名と `defineElement` に渡したオプションと配信の情報を付与した要素コンポーネントを作成する。 */
export function createElementComponent<P, M extends object>(
  tag: string,
  fn: (props: P, ctx: Ctx<M>) => unknown,
  options: ElementOptions,
  delivery?: Delivery,
): ElementComponent<P, M> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const component = ((props: P, ctx: Ctx<M>) => fn(props, ctx)) as (
    props: P,
    ctx: Ctx<M>,
  ) => ClientNode;
  const info: ElementInfo = delivery ? { tag, options, delivery } : { tag, options };
  return Object.assign(component, { [elementInfo]: info });
}

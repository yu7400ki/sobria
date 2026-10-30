import {
  isEventProp,
  propToAttribute,
  type CustomEventName,
  type defaultLoads,
  type EventPropName,
} from "./names.ts";
import type { ClientNode, Slot } from "./nodes.ts";
import { isFunction } from "./objects.ts";
import type { ElementCss } from "./styles.ts";

/** 属性の値から変換する props の型を表す。 */
export type AttributeType = "string" | "number" | "boolean";

/** 属性の値 `value` を、型 `type` の props の値に変換する。属性が無ければ `undefined` を返し、`type` が `undefined` なら文字列のまま返す。 */
export function fromAttribute(value: string | null, type: AttributeType | undefined): unknown {
  if (value === null) return undefined;
  if (type === "number") return Number(value);
  if (type === "boolean") return value !== "false";
  return value;
}

/** 属性の変化を受け取る props の名前と、属性の値を変換した後の型を表す。型が `undefined` なら、属性の値を文字列のまま受け取る。 */
export interface AttributeProp {
  readonly name: string;
  readonly type: AttributeType | undefined;
}

/** 要素の設定から求めた、props の分類を表す。 */
export interface PropKinds {
  /** 受け付ける props の名前を、設定に記述した順に列挙する。 */
  readonly names: readonly string[];
  /** `names` からスロットの props を除いた名前を、設定に記述した順に列挙する。関数の props とオブジェクトの props を含む。 */
  readonly values: readonly string[];
  /** `children` を含む、スロットの props の名前である。 */
  readonly slots: ReadonlySet<string>;
  /** 関数の props のうち、名前が `on` と英字の大文字で始まる props の名前である。これらの props が渡されていないときも、要素の関数は、これらの props の値として関数を受け取る。 */
  readonly events: ReadonlySet<string>;
  /** 属性の名前ごとの、属性の変化を受け取る props である。 */
  readonly attributes: ReadonlyMap<string, AttributeProp>;
  /** ホストの属性に反映する props の名前である。反映した属性の変化は、props に書き戻さない。 */
  readonly reflects: ReadonlySet<string>;
  /** `value` が関数で、`name` が関数の props でなければ `true` を返す。このとき、要素の関数は、`value` を呼び出した戻り値を `name` の props の値として受け取る。 */
  readonly isReader: (name: string, value: unknown) => value is () => unknown;
}

/** 要素の設定 `options` から、props の分類を返す。 */
export function propKinds(options: ElementOptions): PropKinds {
  const slots = new Set(["children"]);
  const values: string[] = [];
  const functions = new Set<string>();
  const attributes = new Map<string, AttributeProp>();
  for (const [name, kind] of Object.entries(options.props)) {
    if (kind === "slot" || name === "children") {
      slots.add(name);
      continue;
    }
    values.push(name);
    if (kind === "function") functions.add(name);
    else if (kind !== "object") {
      attributes.set(propToAttribute(name), { name, type: kind === "unknown" ? undefined : kind });
    }
  }
  return {
    names: Object.keys(options.props),
    values,
    slots,
    events: new Set([...functions].filter(isEventProp)),
    attributes,
    reflects: new Set(options.form ? Object.keys(formAttributeTypes) : []),
    isReader: (name, value): value is () => unknown => isFunction(value) && !functions.has(name),
  };
}

/** フォームの部品が、Props の型に記述していなくても受け付け、ホストの属性に反映する props の名前と、JSX の型で受け付ける値の型である。 */
export const formAttributeTypes = {
  name: "string",
  disabled: "boolean",
} as const satisfies Record<string, AttributeType>;

/**
 * props の分類を表す。
 * `string`、`number`、`boolean` の props は属性の値をその型に変換して受け取り、`unknown` の props は属性の値を文字列のまま受け取る。
 * `function` と `object` の props は属性から受け取らない。`slot` の props はスロットになる。
 */
export type PropKind = AttributeType | "unknown" | "function" | "object" | "slot";

/** `defineElement` の 3 つ目の引数を表す。 */
export interface ElementOptions {
  /** 受け付ける props の名前ごとの分類である。`children` は、表に無いときもスロットになる。 */
  readonly props: Readonly<Record<string, PropKind>> & { readonly children?: "slot" };
  /** 要素の関数が ctx の `form` を使用し、要素がフォームの部品になるときに `true` である。 */
  readonly form?: true;
}

/** ブラウザがフォームの部品の値を復元した理由を表す。`restore` は戻ると進む、`autocomplete` はオートフィルである。 */
export type RestoreMode = "restore" | "autocomplete";

/** フォームの部品が `ElementInternals` に設定し、ブラウザが復元する状態を表す。 */
export type FormState = string | File | FormData | null;

/** `form.validity` に渡す関数が返す、無効の理由を表す。`true` にした制約が 1 つも無ければ `customError` とする。 */
export interface FormInvalidity extends ValidityStateFlags {
  /** 検証エラーの吹き出しに表示する文言である。 */
  readonly message: string;
  /** 検証エラーの吹き出しを表示する位置のノードである。 */
  readonly anchor?: HTMLElement;
}

/** 要素の関数が ctx の `form` で受け取る、フォームの部品の能力を表す。 */
export interface FormControls {
  /**
   * `fn` の戻り値を、フォームで送信する値にする。文字列と File はホストの `name` で送信し、FormData はエントリーごとにエントリーの名前で送信する。
   * `null` と `undefined` は値が無い状態にする。`fn` が読み取った signal が変化するたびに、`fn` を再び実行する。
   */
  readonly value: (fn: () => FormState | undefined) => void;
  /** `fn` が `null` を返すと有効にし、オブジェクトを返すと無効にする。`fn` が読み取った signal が変化するたびに、`fn` を再び実行する。 */
  readonly validity: (fn: () => FormInvalidity | null) => void;
  /** `<form>` がリセットされたときに `fn` を呼ぶ。 */
  readonly onReset: (fn: () => void) => void;
  /** ブラウザが値を復元したときに、復元した値と理由を渡して `fn` を呼ぶ。 */
  readonly onRestore: (fn: (state: FormState, mode: RestoreMode) => void) => void;
  /** 要素自身の `disabled` か、外側の `<fieldset disabled>` で無効になっていれば `true` を返す。 */
  readonly disabled: () => boolean;
}

/** フォームの部品でない `<tag>` の要素の関数に渡す ctx の `form` を返す。`form.value` と `form.validity` はエラーを送出し、`form.disabled()` は `false` を返す。 */
export function unsupportedFormControls(tag: string): FormControls {
  const unsupported = (name: string) => () => {
    throw new Error(
      `[sobria] <${tag}> はフォームの部品として登録されていないので、form.${name}() を呼び出せません。defineElement の設定に form: true を指定してください。`,
    );
  };
  return {
    value: unsupported("value"),
    validity: unsupported("validity"),
    onReset: () => {},
    onRestore: () => {},
    disabled: () => false,
  };
}

/** 要素の関数が 2 番目の引数で受け取る、ホストに依存する能力を表す。 */
export interface Ctx<M extends object = object> {
  /** ホストの要素である。 */
  readonly host: HTMLElement;
  /** フォームの部品の値、検証、リセット、復元、無効の状態を扱う関数である。 */
  readonly form: FormControls;
  /** ホストの `ElementInternals` である。 */
  readonly internals: ElementInternals;
  /** Shadow DOM に適用するスタイルを、呼び出した順に追加する関数である。 */
  readonly css: ElementCss;
  /** 要素が DOM に接続され、最初の内容を Shadow DOM に表示した後に呼ぶ関数を登録する。 */
  readonly onMount: (fn: () => void) => void;
  /** `members` の各プロパティを、その記述子のままホストに追加する。 */
  readonly expose: (members: M) => void;
}

/** 要素コンポーネントに要素の情報を付与するときの、プロパティのキーを表す。 */
export const elementInfo = Symbol.for("sobria.element");

/** 要素のファイルの `export const load` に記述できる、デフォルトの起動タイミングを表す。 */
export type DefaultLoad = (typeof defaultLoads)[number];

/** ブラウザが読み込む要素のモジュールの URL と、要素のデフォルトの起動タイミングを表す。 */
export interface Delivery {
  readonly module: string;
  readonly load: DefaultLoad;
  /** 本番のビルドで、要素のモジュールが静的に import するチャンクの URL である。 */
  readonly chunks?: readonly string[];
}

/**
 * 要素のタグ名と、`defineElement` に渡したオプションを表す。`delivery` は、Vite プラグインがコンパイルしたサーバー向けの要素だけが持つ。
 * @internal
 */
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
 * 関数 `F` の props を呼んだときに発行する `CustomEvent` の `detail` の型を表す。
 * 引数が無ければ `null` を表し、それ以外では、最初の引数の型から `undefined` を除いて `null` を加えた型を表す。
 */
type DetailOf<F extends (...args: never[]) => unknown> =
  Parameters<F> extends []
    ? null
    : Exclude<Parameters<F>[0], undefined> | (undefined extends Parameters<F>[0] ? null : never);

/** Props の型 `P` の props ごとに、関数の型の props なら、その props を呼んだときに発行する `CustomEvent` の `detail` の型を表す。ほかの props では `never` を表す。 */
export type DetailMap<P> = {
  [K in keyof P]-?: NonNullable<P[K]> extends infer F extends (...args: never[]) => unknown
    ? DetailOf<F>
    : never;
};

/** イベント名 `N` の `CustomEvent` の型 `E` を表す。`HTMLElement` のイベントと同じ名前なら、そのイベントの型との合併を表す。 */
type WithNativeEvent<N, E> = N extends keyof HTMLElementEventMap ? E | HTMLElementEventMap[N] : E;

/** Props の型 `P` のイベントの props から、要素が発行する `CustomEvent` の名前と、その `CustomEvent` の型の対応を表す。 */
type ElementEventMap<P> = {
  [
    K in keyof P as K extends EventPropName
      ? NonNullable<P[K]> extends (...args: never[]) => unknown
        ? CustomEventName<K>
        : never
      : never
  ]-?: K extends EventPropName
    ? WithNativeEvent<CustomEventName<K>, CustomEvent<DetailMap<P>[K]>>
    : never;
};

/** イベント名から `CustomEvent` の型への対応 `E` について、リスナーを登録する関数と、解除する関数を表す。 */
interface ElementEventListeners<E> {
  addEventListener<K extends keyof E & string>(
    type: K,
    listener: (this: HTMLElement, event: E[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof E & string>(
    type: K,
    listener: (this: HTMLElement, event: E[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
}

/**
 * 要素の関数か要素コンポーネント `C` の、インスタンスの型を表す。
 * `ctx.expose` で公開したメンバーと、スロットになる props を除いた props を持つ。
 * 公開したメンバーと同じ名前の `HTMLElement` のメンバーは、公開した側の型になる。
 * `addEventListener` と `removeEventListener` の型は、`onX` の形の名前の関数の props から決まる名前のイベントを、`CustomEvent` として扱う。
 */
export type ElementRef<C> = C extends (props: infer P, ctx: Ctx<infer M>) => unknown
  ? ElementEventListeners<ElementEventMap<P>> &
      Omit<HTMLElement, keyof M> &
      M &
      Omit<P, SlotKeys<P>>
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

import {
  createRenderEffect,
  getOwner,
  onCleanup,
  runWithOwner,
  untrack,
  type Owner,
} from "@solidjs/signals";

import { attributeValue, propertiesOf, tagAttributeName } from "../shared/attributes.ts";
import { isEventProp, listenerEventName } from "../shared/names.ts";
import type { ClientNode } from "../shared/nodes.ts";
import { isFunction } from "../shared/objects.ts";
import { outsideScope } from "../shared/scope.ts";
import { formProps } from "../shared/wire.ts";
import { registerSlot } from "./slots.ts";

/**
 * JSX が作成した、まだ挿入する値にしていないタグ、要素、境界を表す。
 * `insert` が最初に挿入するときに、JSX を評価した時点の owner の下で `make` を呼ぶ。
 * 2 回目以降の挿入では、最初に作成した値を挿入する。ノードなら、そのノードを移動する。`make` が投げた値は、挿入するたびに投げ直す。
 */
export class Deferred {
  readonly #owner: Owner | null = getOwner();
  readonly #make: () => unknown;
  #result: { readonly value: unknown } | { readonly error: unknown } | undefined;

  constructor(make: () => unknown) {
    this.#make = make;
  }

  /** 挿入する値を返す。まだ作成していなければ作成する。 */
  value(): unknown {
    this.#result ??= this.#create();
    if ("error" in this.#result) throw this.#result.error;
    return this.#result.value;
  }

  #create(): { readonly value: unknown } | { readonly error: unknown } {
    try {
      return { value: runWithOwner(this.#owner, this.#make) };
    } catch (error) {
      return { error };
    }
  }
}

/** `content` を挿入したノードの列を返す。`content` の中の関数は、それぞれ領域になる。 */
export function build(content: unknown): Node[] {
  const fragment = document.createDocumentFragment();
  insert(fragment, content);
  return [...fragment.childNodes];
}

/** DOM に挿入できる値を表す。関数は、値が変化するたびに挿入し直す領域になる。 */
export type Child =
  | Node
  | ClientNode
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly Child[]
  | (() => Child);

/** JSX に記述するコンポーネントの関数を表す。 */
export type Component<P> = (props: P) => unknown;

/** JSX を評価した実行時の値（DOM のノードと、挿入できる値）を、`ClientNode` の型として扱う。 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
export const asClientNode = (value: unknown): ClientNode => value as ClientNode;

/** `ref` を呼び、`ref` が返した関数を描画の範囲の後始末に登録する。`ref` は `runWithOwner(null, …)` の中で呼ぶ。 */
export function callRef<T>(ref: (node: T) => unknown, node: T): void {
  const cleanup = runWithOwner(null, () => ref(node));
  if (isFunction(cleanup)) onCleanup(() => void cleanup());
}

/** `isProperty` が `true` ならプロパティとして、`false` なら属性として、値を設定する関数を返す。プロパティの `null` と `undefined` は `""` にする。 */
export function setter(el: Element, name: string, isProperty: boolean): (value: unknown) => void {
  if (isProperty) {
    return (value) => {
      Reflect.set(el, name, value ?? "");
    };
  }
  const attribute = tagAttributeName(name);
  return (value) => {
    const text = attributeValue(name, value);
    if (text === null) el.removeAttribute(attribute);
    else el.setAttribute(attribute, text);
  };
}

/** `value` を `set` に渡す。関数の値は、値が変化するたびに渡し直す。 */
export function bind(value: unknown, set: (value: unknown) => void): void {
  if (isFunction(value)) createRenderEffect(() => outsideScope(value), set);
  else set(value);
}

/** `onX` の名前の関数は `el` のリスナーにし、それ以外の値は `el` の属性にする。 */
export function applyAttribute(el: Element, name: string, value: unknown): void {
  if (isEventProp(name) && isFunction(value)) el.addEventListener(listenerEventName(name), value);
  else bind(value, setter(el, name, false));
}

/** ネイティブのタグのノードを作成する。子、属性、プロパティの順に設定する。 */
function createTag(tag: string, given: Record<string, unknown>): Element {
  const props = tag === "form" ? formProps(given) : given;
  const el = document.createElement(tag);
  if (props.children !== undefined) insert(el, props.children);
  const outputs = propertiesOf(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === "children" || name === "ref" || outputs.has(name)) continue;
    applyAttribute(el, name, value);
  }
  for (const name of outputs.keys()) {
    if (name in props) bind(props[name], setter(el, name, true));
  }
  if (tag === "slot") registerSlot(typeof props.name === "string" ? props.name : "");
  if (isFunction(props.ref)) callRef(props.ref, el);
  return el;
}

/**
 * `value` を `parent` の末尾に挿入する。配列は要素ごとに挿入する。
 * 関数の値は、2 つのコメントで囲んだ領域になり、値が変化するたびに領域の中身を置換する。
 * `Deferred` は、作成した値を挿入する。文字列、数値、bigint、ノードは、`place` で変換してから挿入する。
 */
export function insert(
  parent: ParentNode,
  value: unknown,
  place: (node: Node) => Node = (node) => node,
): void {
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) insert(parent, item, place);
  } else if (isFunction(value)) {
    const start = document.createComment("");
    const end = document.createComment("");
    parent.append(start, end);
    createRenderEffect(
      () => {
        const fragment = document.createDocumentFragment();
        insert(fragment, outsideScope(value), place);
        return fragment;
      },
      (fragment) => {
        while (start.nextSibling && start.nextSibling !== end) start.nextSibling.remove();
        end.before(fragment);
      },
    );
  } else if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    parent.append(place(document.createTextNode(String(value))));
  } else if (value instanceof Node) {
    parent.append(place(value));
  } else if (value instanceof Deferred) {
    insert(parent, value.value(), place);
  }
}

/** ネイティブのタグは、挿入するときにノードを作成する `Deferred` を返す。コンポーネントは props を渡して、読み取った値を追跡せずに 1 回だけ呼ぶ。 */
export function createNode(
  type: string | Component<Record<string, unknown>>,
  props: Record<string, unknown>,
  key?: string,
): ClientNode {
  if (typeof type === "string") {
    const given = key === undefined ? props : { ...props, key };
    return asClientNode(new Deferred(() => createTag(type, given)));
  }
  return asClientNode(untrack(() => outsideScope(() => type(props))));
}

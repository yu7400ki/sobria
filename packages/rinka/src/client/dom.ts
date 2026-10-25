import { createRenderEffect, onCleanup, runWithOwner, untrack } from "@solidjs/signals";

import { attributeValue, tagAttributeName, tagProperties } from "../shared/attributes.ts";
import { isEventProp, listenerEventName } from "../shared/names.ts";
import type { ClientNode } from "../shared/nodes.ts";
import { isFunction } from "../shared/objects.ts";
import { outsideScope } from "../shared/scope.ts";
import { formProps } from "../shared/wire.ts";
import { registerSlot } from "./slots.ts";

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
  const propertyNames = Object.keys(tagProperties[tag] ?? {});
  for (const [name, value] of Object.entries(props)) {
    if (name === "children" || name === "ref" || propertyNames.includes(name)) continue;
    applyAttribute(el, name, value);
  }
  for (const name of propertyNames) {
    if (name in props) bind(props[name], setter(el, name, true));
  }
  if (tag === "slot") registerSlot(typeof props.name === "string" ? props.name : "");
  if (isFunction(props.ref)) callRef(props.ref, el);
  return el;
}

/**
 * `value` を `parent` の末尾に挿入する。配列は要素ごとに挿入する。
 * 関数の値は、2 つのコメントで囲んだ領域になり、値が変化するたびに領域の中身を置換する。
 * 文字列、数値、bigint、ノードは、`place` で変換してから挿入する。
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
  }
}

/** ネイティブのタグはノードを作成し、コンポーネントは props を渡して、読み取った値を追跡せずに 1 回だけ呼ぶ。 */
export function createNode(
  type: string | Component<Record<string, unknown>>,
  props: Record<string, unknown>,
  key?: string,
): ClientNode {
  if (typeof type === "string") {
    return asClientNode(createTag(type, key === undefined ? props : { ...props, key }));
  }
  return asClientNode(untrack(() => outsideScope(() => type(props))));
}

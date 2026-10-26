import {
  createRenderEffect,
  getOwner,
  onCleanup,
  runWithOwner,
  untrack,
  type Owner,
} from "@solidjs/signals";

import {
  attributeValue,
  propertiesOf,
  REGION_END,
  REGION_START,
  tagAttributeName,
} from "../shared/attributes.ts";
import { isEventProp, listenerEventName } from "../shared/names.ts";
import type { ClientNode } from "../shared/nodes.ts";
import { isFunction } from "../shared/objects.ts";
import { outsideScope } from "../shared/scope.ts";
import { formProps } from "../shared/wire.ts";
import {
  claimChildren,
  atServerFallback,
  claimNode,
  currentCursor,
  fail,
  cursorOf,
  isBuilt,
  serverOnly,
  skipRegion,
  takeComment,
  takeElement,
  takeText,
  within,
  type Cursor,
} from "./hydration.ts";
import { registerSlot } from "./slots.ts";

/** フォールバックを返す境界の種類を表す。 */
export type Boundary = "loading" | "errored";

/**
 * JSX が作成した、まだ挿入する値にしていないタグ、要素、境界を表す。
 * `insert` が最初に挿入するときに、JSX を評価した時点の owner の下で `make` を呼ぶ。
 * 2 回目以降の挿入では、最初に作成した値を挿入する。ノードなら、そのノードを移動する。`make` が投げた値は、挿入するたびに投げ直す。
 */
export class Deferred {
  readonly #owner: Owner | null = getOwner();
  readonly #make: () => unknown;
  #result: { readonly value: unknown } | { readonly error: unknown } | undefined;
  /**
   * `make` が、挿入すると 1 つの領域になる境界の関数を返し、境界の中身を `make` の中でノードにするときの境界の種類である。
   * `"loading"` の境界は、中身が保留中ならフォールバックを返し、`"errored"` の境界は、中身が投げたらフォールバックを返す。
   */
  readonly boundary: Boundary | undefined;

  constructor(make: () => unknown, boundary?: Boundary) {
    this.#make = make;
    this.boundary = boundary;
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

/**
 * `content` を挿入したノードの列を返す。`content` の中の関数は、それぞれ領域になる。
 * 引き取りの最中なら、位置からノードを引き取り、引き取った範囲にあるノードの列を返す。列には、サーバーだけが出力したノードを含めない。
 */
export function build(content: unknown): Node[] {
  const at = currentCursor();
  if (at && at.hydration.failure === undefined) {
    const nodes: Node[] = [];
    const before = at.next === null ? at.parent.lastChild : at.next.previousSibling;
    insert(at.parent, content);
    let node = before === null ? at.parent.firstChild : before.nextSibling;
    for (; node !== null && node !== at.next; node = node.nextSibling) {
      if (!serverOnly(node)) nodes.push(node);
    }
    at.hydration.built.add(nodes);
    return nodes;
  }
  const fragment = document.createDocumentFragment();
  within(undefined, () => insert(fragment, content));
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

/** `onX` の名前の関数は `el` のリスナーにし、それ以外の値は `el` の属性にする。リスナーは、描画の範囲を破棄したときに外す。 */
export function applyAttribute(el: Element, name: string, value: unknown): void {
  if (!isEventProp(name) || !isFunction(value)) {
    bind(value, setter(el, name, false));
    return;
  }
  const type = listenerEventName(name);
  el.addEventListener(type, value);
}

/** 中身を引き取らずに作成し直すタグである。中身は、サーバーが出力したテキストで、コメントを含められない。 */
const rawTextTags: ReadonlySet<string> = new Set(["title", "textarea", "script", "style"]);

/**
 * ネイティブのタグのノードを作成する。子、属性、プロパティの順に設定する。
 * 引き取りの最中なら、位置にある同じタグの要素を引き取り、子も引き取る。
 */
function createTag(tag: string, given: Record<string, unknown>): Element {
  const props = tag === "form" ? formProps(given) : given;
  const at = currentCursor();
  const claimed = at && takeElement(at, tag);
  const el = claimed ?? document.createElement(tag);
  if (at && !claimed) return el;
  const children = () => {
    if (props.children !== undefined) insert(el, props.children);
  };
  if (!at) {
    within(undefined, children);
  } else if (rawTextTags.has(tag)) {
    if (props.children !== undefined) el.replaceChildren();
    within(undefined, children);
  } else {
    claimChildren(el, el.firstChild, at.hydration, children);
  }
  const outputs = propertiesOf(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === "children" || name === "ref" || outputs.has(name)) continue;
    applyAttribute(el, name, value);
  }
  for (const name of outputs.keys()) {
    if (name in props) bind(props[name], setter(el, name, true));
  }
  if (tag === "slot") registerSlot(typeof props.name === "string" ? props.name : "");
  if (isFunction(props.ref) && at?.hydration.failure === undefined) callRef(props.ref, el);
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
  const at = cursorOf(parent);
  // 引き取りに失敗した要素は作り直すので、残りの値はノードにしない。
  if (at?.hydration.failure !== undefined) return;
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) insert(parent, item, place);
  } else if (isFunction(value)) {
    const start = at && takeComment(at, REGION_START);
    if (!at) createRegion(parent, value, place);
    else if (start) claimRegion(parent, value, place, at, start);
  } else if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    if (at) claimText(at, String(value), place);
    else parent.append(place(document.createTextNode(String(value))));
  } else if (value instanceof Node) {
    if (at) claimNode(at, place(value));
    else parent.append(place(value));
  } else if (value instanceof Deferred) {
    if (at && value.boundary) {
      const start = takeComment(at, REGION_START);
      const fresh = start !== undefined && atServerFallback(at);
      const end = fresh ? skipRegion(at, start) : undefined;
      const made = start && within(fresh ? undefined : at, () => value.value());
      if (!start) return;
      if (!isFunction(made)) fail(at, "領域になる値");
      else if (fresh) updateRegion(start, () => end, made, place);
      else claimRegion(parent, made, place, at, start, value.boundary);
    } else {
      insert(
        parent,
        within(at, () => value.value()),
        place,
      );
    }
  }
}

/** `value` が、`start` と `end` の間にあるノードの列そのものなら `true` を返す。 */
function placed(start: Comment, end: Comment, value: unknown): boolean {
  const nodes = Array.isArray(value) ? (value as unknown[]) : [value];
  let node = start.nextSibling;
  for (const item of nodes) {
    if (item !== node || node === null) return false;
    node = node.nextSibling;
  }
  return node === end;
}

/** 値が変化するたびに中身を置換する領域を、`parent` の末尾に作成する。 */
function createRegion(parent: ParentNode, value: () => unknown, place: (node: Node) => Node): void {
  const start = document.createComment(REGION_START);
  const end = document.createComment(REGION_END);
  parent.append(start, end);
  updateRegion(start, () => end, value, place);
}

/** `start` と `end()` の間を、`value` の値が変化するたびに置換する。`end()` が `undefined` なら、引き取りに失敗した領域なので、何もしない。 */
function updateRegion(
  start: Comment,
  end: () => Comment | undefined,
  value: () => unknown,
  place: (node: Node) => Node,
  first?: () => boolean,
): void {
  let claiming = first !== undefined;
  createRenderEffect(
    () => {
      if (claiming) {
        claiming = false;
        if (first?.()) return undefined;
      }
      const last = end();
      if (last === undefined) return undefined;
      const current = outsideScope(value);
      if (placed(start, last, current)) return undefined;
      const fragment = document.createDocumentFragment();
      within(undefined, () => insert(fragment, current, place));
      return fragment;
    },
    (fragment) => {
      const last = end();
      if (fragment === undefined || last === undefined) return;
      while (start.nextSibling && start.nextSibling !== last) start.nextSibling.remove();
      last.before(fragment);
    },
  );
}

/**
 * 位置にある領域を引き取る。`start` は引き取った開始の目印である。
 * 最初の計算では、`value` の値を位置から引き取り、終了の目印を引き取る。`boundary` なら、値は中身を引き取ったノードの列か、境界のフォールバックである。
 * `"loading"` の境界がフォールバックを返したときと、最初の計算が投げたときは、領域の SSR のノードを残して終了の目印まで進め、値が変化したときに置換する。
 * `"errored"` の境界がフォールバックを返したら、終了の目印まで進め、領域の中身をフォールバックで置換する。
 */
function claimRegion(
  parent: ParentNode,
  value: () => unknown,
  place: (node: Node) => Node,
  at: Cursor,
  start: Comment,
  boundary?: Boundary,
): void {
  let end: Comment | undefined;
  updateRegion(
    start,
    () => end,
    value,
    place,
    () => {
      try {
        const current = outsideScope(value);
        if (boundary === undefined) {
          within(at, () => insert(parent, current, place));
        } else if (at.hydration.failure === undefined && !isBuilt(at.hydration, current)) {
          end = skipRegion(at, start);
          return boundary === "loading";
        }
      } catch (error) {
        end = skipRegion(at, start);
        throw error;
      }
      end = takeComment(at, REGION_END);
      return true;
    },
  );
}

/** 位置にあるテキストを引き取る。`place` がテキストを要素で包むなら、その要素を引き取ってから、中のテキストを引き取る。 */
function claimText(at: Cursor, text: string, place: (node: Node) => Node): void {
  const wrapped = place(document.createTextNode(text));
  if (!(wrapped instanceof Element)) {
    takeText(at, text);
    return;
  }
  const wrapper = takeElement(at, wrapped.localName);
  if (wrapper) {
    claimChildren(wrapper, wrapper.firstChild, at.hydration, () => insert(wrapper, text));
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

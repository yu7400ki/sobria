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
  rawTextTags,
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
  atServerFallback,
  childCursor,
  claiming,
  claimWithin,
  describe,
  fail,
  takeElement,
  takeRegion,
  takeText,
  type Cursor,
  type Region,
} from "./hydration.ts";
import { registerSlot } from "./slots.ts";

/** フォールバックを返す境界の種類を表す。 */
export type Boundary = "loading" | "errored";

/**
 * JSX が作成した、まだ挿入する値にしていない値を表す。
 * 最初に値を求めたときに、JSX を評価した時点の owner の下で `make` を呼ぶ。引き取りの最中なら、`make` には引き取りの位置を渡す。
 * 2 回目以降は、最初に作成した値を返す。`make` が投げた値は、値を求めるたびに投げ直す。
 */
class Lazy<T> {
  readonly #owner: Owner | null = getOwner();
  readonly #make: (at: Cursor | undefined) => T;
  #result: { readonly value: T } | { readonly error: unknown } | undefined;

  constructor(make: (at: Cursor | undefined) => T) {
    this.#make = make;
  }

  /** 値を作成していれば `true` を返す。 */
  get created(): boolean {
    return this.#result !== undefined;
  }

  /** 値を返す。まだ作成していなければ、`at` の位置で作成する。 */
  value(at?: Cursor): T {
    this.#result ??= this.#create(at);
    if ("error" in this.#result) throw this.#result.error;
    return this.#result.value;
  }

  #create(at: Cursor | undefined): { readonly value: T } | { readonly error: unknown } {
    try {
      return { value: runWithOwner(this.#owner, () => this.#make(at)) };
    } catch (error) {
      return { error };
    }
  }
}

/** JSX が作成した、ネイティブのタグか要素のホストのノードを表す。引き取りの最中に作成すると、位置にあるノードを引き取る。 */
export class Deferred extends Lazy<Node> {}

/**
 * JSX が作成した境界と、要素の描画の全体を表す。値は、挿入すると 1 つの領域になる関数である。
 * 境界の中身は、作成するときにノードにする。`boundary` は、値が中身でないときに SSR の表示を残すか置換するかを決める。
 */
export class DeferredRegion extends Lazy<() => unknown> {
  /** `"loading"` の境界は、中身が保留中ならフォールバックを返し、`"errored"` の境界は、中身が投げたらフォールバックを返す。 */
  readonly boundary: Boundary;

  constructor(make: (at: Cursor | undefined) => () => unknown, boundary: Boundary) {
    super(make);
    this.boundary = boundary;
  }
}

/**
 * `content` を挿入したノードの列を返す。`content` の中の関数は、それぞれ領域になる。
 * 最初の描画の引き取りの最中なら、`at` の位置から範囲の終わりまでノードを引き取り、範囲にあるノードの列を返す。
 */
export function build(content: unknown, at: Cursor | undefined): Node[] {
  if (at && at.hydration.state !== "done") {
    const before = at.next === null ? at.parent.lastChild : at.next.previousSibling;
    if (!claimWithin(at, (inner) => insert(inner, content))) return [];
    const nodes: Node[] = [];
    let node = before === null ? at.parent.firstChild : before.nextSibling;
    for (; node !== null && node !== at.next; node = node.nextSibling) nodes.push(node);
    return nodes;
  }
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

/** `el` の属性 `name` に値を設定する関数を返す。 */
export function attributeSetter(el: Element, name: string): (value: unknown) => void {
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
    bind(value, attributeSetter(el, name));
    return;
  }
  const type = listenerEventName(name);
  el.addEventListener(type, value);
}

/** 最初の呼び出しを無視し、2 回目以降の値を `set` に渡す関数を返す。 */
function afterFirst(set: (value: unknown) => void): (value: unknown) => void {
  let first = true;
  return (value) => {
    if (first) first = false;
    else set(value);
  };
}

/** `el` の今の属性と中身を解析し直した要素を返す。返す要素の状態は、利用者の操作を含まない。 */
function reparse(el: Element): Element | null {
  const template = document.createElement("template");
  template.innerHTML = el.outerHTML;
  return template.content.firstElementChild;
}

/** フォームの部品の値を、利用者が文書を読み込んだ後に変更していれば `true` を返す。`<option>` は、親の `<select>` の選択で判定する。 */
function edited(el: Element): boolean {
  const part = el instanceof HTMLOptionElement ? el.closest("select") : el;
  if (part instanceof HTMLTextAreaElement) return part.value !== part.defaultValue;
  if (part === null) return false;
  const initial = reparse(part);
  if (part instanceof HTMLSelectElement && initial instanceof HTMLSelectElement) {
    return [...part.options].some(
      (option, index) => option.selected !== initial.options[index]?.selected,
    );
  }
  if (part instanceof HTMLInputElement && initial instanceof HTMLInputElement) {
    return part.value !== initial.value || part.checked !== initial.checked;
  }
  return false;
}

/**
 * ネイティブのタグのノードを作成する。子、属性、プロパティの順に設定する。
 * `at` があれば、位置にある同じタグの要素を引き取り、子も引き取る。
 */
function createTag(tag: string, given: Record<string, unknown>, at: Cursor | undefined): Element {
  const props = tag === "form" ? formProps(given) : given;
  const claimed = at && takeElement(at, tag);
  if (at && !claimed) return document.createElement(tag);
  const el = claimed ?? document.createElement(tag);
  if (at && !rawTextTags.has(tag)) {
    claimWithin(childCursor(el, at.hydration), (inner) => {
      if (props.children !== undefined) insert(inner, props.children);
    });
  } else if (props.children !== undefined) {
    if (at) el.replaceChildren();
    insert(el, props.children);
  }
  const outputs = propertiesOf(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === "children" || name === "ref" || outputs.has(name)) continue;
    applyAttribute(el, name, value);
  }
  const kept = claimed !== undefined && outputs.size > 0 && edited(el);
  for (const name of outputs.keys()) {
    if (!(name in props)) continue;
    const set = (value: unknown): void => {
      Reflect.set(el, name, value ?? "");
    };
    bind(props[name], kept ? afterFirst(set) : set);
  }
  if (tag === "slot") registerSlot(typeof props.name === "string" ? props.name : "");
  if (isFunction(props.ref) && (!at || claiming(at.hydration))) callRef(props.ref, el);
  return el;
}

/**
 * `value` を `target` の末尾に挿入する。配列は要素ごとに挿入する。
 * `target` が引き取りの位置なら、位置から値のノードを引き取る。引き取りの最中でなければ、何もしない。
 * 関数の値は、2 つのコメントで囲んだ領域になり、値が変化するたびに領域の中身を置換する。
 * 文字列、数値、bigint、ノードは、`place` で変換してから挿入する。
 */
export function insert(
  target: ParentNode | Cursor,
  value: unknown,
  place: (node: Node) => Node = (node) => node,
): void {
  const at = "hydration" in target ? target : undefined;
  if (at && !claiming(at.hydration)) return;
  const parent = "hydration" in target ? target.parent : target;
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) insert(target, item, place);
  } else if (isFunction(value)) {
    if (!at) createRegion(parent, value, place);
    else claimRegion(takeRegion(at), value, place);
  } else if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    if (at) claimText(at, String(value), place);
    else parent.append(place(document.createTextNode(String(value))));
  } else if (value instanceof Node) {
    if (at) fail(at, describe(value));
    else parent.append(place(value));
  } else if (value instanceof Lazy && at && value.created) {
    fail(at, "作成済みの値");
  } else if (value instanceof Deferred) {
    if (!at) parent.append(place(value.value()));
    else place(value.value(at));
  } else if (value instanceof DeferredRegion) {
    if (!at) createRegion(parent, value.value(), place);
    else claimBoundary(takeRegion(at), value, place);
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
  updateRegion(start, end, value, place);
}

/**
 * `start` と `end` の間を、`value` の値が変化するたびに置換する。
 * `first` があれば、最初の計算では `first` を呼び、`first` が `true` を返したら置換しない。
 */
function updateRegion(
  start: Comment,
  end: Comment,
  value: () => unknown,
  place: (node: Node) => Node,
  first?: () => boolean,
): void {
  let initial = first !== undefined;
  createRenderEffect(
    () => {
      if (initial) {
        initial = false;
        if (first?.()) return undefined;
      }
      const current = outsideScope(value);
      if (placed(start, end, current)) return undefined;
      const fragment = document.createDocumentFragment();
      insert(fragment, current, place);
      return fragment;
    },
    (fragment) => {
      if (fragment === undefined) return;
      while (start.nextSibling && start.nextSibling !== end) start.nextSibling.remove();
      end.before(fragment);
    },
  );
}

/**
 * 引き取った領域で、最初の計算の値のノードを領域の中身から引き取る。
 * 最初の計算が投げたら、領域の SSR のノードを残し、値が変化したときに置換する。
 */
function claimRegion(
  region: Region | undefined,
  value: () => unknown,
  place: (node: Node) => Node,
): void {
  if (!region) return;
  const { start, end, inner } = region;
  updateRegion(start, end, value, place, () => {
    claimWithin(inner, (within) => insert(within, outsideScope(value), place));
    return true;
  });
}

/**
 * 引き取った領域で、境界を作成する。境界の中身は、作成するときに領域の中身から引き取る。
 * サーバーが境界の中身を出力しなかった領域と、`"errored"` の境界がフォールバックを返した領域は、領域の中身を置換する。
 * `"loading"` の境界がフォールバックを返したときと、最初の計算が投げたときは、領域の SSR のノードを残し、値が変化したときに置換する。
 */
function claimBoundary(
  region: Region | undefined,
  value: DeferredRegion,
  place: (node: Node) => Node,
): void {
  if (!region) return;
  const { start, end, inner } = region;
  const fresh = atServerFallback(inner);
  const made = value.value(fresh ? undefined : inner);
  updateRegion(start, end, made, place, () => {
    if (fresh) return false;
    if (!claiming(inner.hydration)) return true;
    return placed(start, end, outsideScope(made)) || value.boundary === "loading";
  });
}

/** 位置にあるテキストを引き取る。`place` がテキストを要素で包むなら、その要素を引き取ってから、中のテキストを引き取る。 */
function claimText(at: Cursor, text: string, place: (node: Node) => Node): void {
  const wrapped = place(document.createTextNode(text));
  if (!(wrapped instanceof Element)) {
    takeText(at, text);
    return;
  }
  const wrapper = takeElement(at, wrapped.localName);
  if (!wrapper) return;
  claimWithin(childCursor(wrapper, at.hydration), (inner) => takeText(inner, text));
}

/** ネイティブのタグは、挿入するときにノードを作成する `Deferred` を返す。コンポーネントは props を渡して、読み取った値を追跡せずに 1 回だけ呼ぶ。 */
export function createNode(
  type: string | Component<Record<string, unknown>>,
  props: Record<string, unknown>,
  key?: string,
): ClientNode {
  if (typeof type === "string") {
    const given = key === undefined ? props : { ...props, key };
    return asClientNode(new Deferred((at) => createTag(type, given, at)));
  }
  return asClientNode(untrack(() => outsideScope(() => type(props))));
}

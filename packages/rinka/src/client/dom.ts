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
import { isEventProp, listenerEventName, slotNameOf } from "../shared/names.ts";
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
  withHydrating,
  type Cursor,
  type Region,
} from "./hydration.ts";
import { registerSlot } from "./slots.ts";

/** HTML の名前空間である。 */
export const HTML_NS = "http://www.w3.org/1999/xhtml";

/** SVG の名前空間である。 */
export const SVG_NS = "http://www.w3.org/2000/svg";

/** タグを作成する名前空間を表す。 */
export type Namespace = typeof HTML_NS | typeof SVG_NS;

/** `parent` の子のタグを作成する名前空間を返す。`parent` が `<foreignObject>` 以外の SVG のタグなら SVG の名前空間を、それ以外なら HTML の名前空間を返す。 */
function childNamespace(parent: ParentNode): Namespace {
  return parent instanceof Element &&
    parent.namespaceURI === SVG_NS &&
    parent.localName !== "foreignObject"
    ? SVG_NS
    : HTML_NS;
}

/** 引き取った領域で、最初の値のノードが領域の中身と異なるときの扱いを表す。`keep` は SSR のノードを残して値が変化したときに置換し、`replace` は最初の値のノードで置換する。 */
export type Mismatch = "keep" | "replace";

/**
 * JSX が作成した、まだ挿入する値にしていない値を表す。
 * 最初に値を求めたときに、JSX を評価した時点の owner の下で `make` を呼ぶ。引き取りの最中なら、`make` には引き取りの位置を渡す。`make` には、値のタグを作成する名前空間と、挿入するノードを変換する関数も渡す。
 * 2 回目以降は、最初に作成した値を返す。`make` が投げた値は、値を求めるたびに投げ直す。
 */
class Lazy<T> {
  readonly #owner: Owner | null = getOwner();
  readonly #make: (at: Cursor | undefined, ns: Namespace, place: (node: Node) => Node) => T;
  #result: { readonly value: T } | { readonly error: unknown } | undefined;

  constructor(make: (at: Cursor | undefined, ns: Namespace, place: (node: Node) => Node) => T) {
    this.#make = make;
  }

  /** 値を作成していれば `true` を返す。 */
  get created(): boolean {
    return this.#result !== undefined;
  }

  /** 値を返す。まだ作成していなければ、`at` の位置で、名前空間 `ns` のタグとして作成し、挿入するノードを `place` で変換する。 */
  value(at: Cursor | undefined, ns: Namespace, place: (node: Node) => Node = (node) => node): T {
    this.#result ??= this.#create(at, ns, place);
    if ("error" in this.#result) throw this.#result.error;
    return this.#result.value;
  }

  #create(
    at: Cursor | undefined,
    ns: Namespace,
    place: (node: Node) => Node,
  ): { readonly value: T } | { readonly error: unknown } {
    try {
      return {
        value: runWithOwner(this.#owner, () =>
          withHydrating(at !== undefined, () => this.#make(at, ns, place)),
        ),
      };
    } catch (error) {
      return { error };
    }
  }
}

/** JSX が作成した、ネイティブのタグか要素のホストのノードを表す。引き取りの最中に作成すると、位置にあるノードを引き取る。 */
export class Deferred extends Lazy<Node> {}

/**
 * JSX が作成した境界と、`<For>` の項目の列と、要素の描画の全体を表す。値は、挿入すると 1 つの領域になる関数である。
 * 境界の中身は、作成するときにノードにする。`onMismatch` は、最初の値のノードが SSR の表示と異なるときに、SSR の表示を残すか置換するかを決める。
 */
export class DeferredRegion extends Lazy<() => unknown> {
  readonly onMismatch: Mismatch;

  constructor(
    make: (at: Cursor | undefined, ns: Namespace, place: (node: Node) => Node) => () => unknown,
    onMismatch: Mismatch,
  ) {
    super(make);
    this.onMismatch = onMismatch;
  }
}

/**
 * `content` を挿入したノードの配列を返す。引き取りの最中なら、`at` の位置から `content` のノードを引き取り、`at` を引き取ったノードの後に進める。
 * 引き取りの最中でなければ、`content` のタグを名前空間 `ns` で作成する。挿入するノードは `place` で変換する。
 */
export function buildAt(
  content: unknown,
  at: Cursor | undefined,
  ns: Namespace,
  place?: (node: Node) => Node,
): Node[] {
  if (at === undefined || at.hydration.state === "done")
    return build(content, undefined, ns, place);
  const before = at.next === null ? at.parent.lastChild : at.next.previousSibling;
  insert(at, content, place);
  const nodes: Node[] = [];
  let node = before === null ? at.parent.firstChild : before.nextSibling;
  for (; node !== null && node !== at.next; node = node.nextSibling) nodes.push(node);
  return nodes;
}

/**
 * `content` を挿入したノードの列を返す。`content` の中の関数は、それぞれ領域になる。
 * 最初の描画の引き取りの最中なら、`at` の位置から範囲の終わりまでノードを引き取り、範囲にあるノードの列を返す。
 * 引き取りの最中でなければ、`content` のタグを名前空間 `ns` で作成する。挿入するノードは `place` で変換する。
 */
export function build(
  content: unknown,
  at: Cursor | undefined,
  ns: Namespace,
  place?: (node: Node) => Node,
): Node[] {
  if (at && at.hydration.state !== "done") {
    let nodes: Node[] = [];
    if (!claimWithin(at, (inner) => (nodes = buildAt(content, inner, ns, place)))) return [];
    return nodes;
  }
  const fragment = document.createDocumentFragment();
  insert(fragment, content, place, ns);
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
 * `<svg>` は SVG の名前空間で、それ以外のタグは名前空間 `ns` で作成する。
 * `at` があれば、位置にある同じタグの要素を引き取り、子も引き取る。
 */
function createTag(
  tag: string,
  given: Record<string, unknown>,
  at: Cursor | undefined,
  ns: Namespace,
): Element {
  const props = tag === "form" ? formProps(given, createNode) : given;
  const space = tag === "svg" ? SVG_NS : ns;
  const claimed = at && takeElement(at, tag);
  if (at && !claimed) return document.createElementNS(space, tag);
  const el = claimed ?? document.createElementNS(space, tag);
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
  if (tag === "slot") registerSlot(slotNameOf(props.name));
  if (isFunction(props.ref) && (!at || claiming(at.hydration))) callRef(props.ref, el);
  return el;
}

/**
 * `value` を `target` の末尾に挿入する。配列は要素ごとに挿入する。
 * `target` が引き取りの位置なら、位置から値のノードを引き取る。引き取りの最中でなければ、何もしない。
 * 関数の値は、2 つのコメントで囲んだ領域になり、値が変化するたびに領域の中身を置換する。
 * 文字列、数値、bigint、ノードは、`place` で変換してから挿入する。
 * 値のタグは、名前空間 `ns` で作成する。`ns` を省略すると、挿入先の親のノードから名前空間を決定する。
 */
export function insert(
  target: ParentNode | Cursor,
  value: unknown,
  place: (node: Node) => Node = (node) => node,
  ns?: Namespace,
): void {
  const at = "hydration" in target ? target : undefined;
  if (at && !claiming(at.hydration)) return;
  const parent = "hydration" in target ? target.parent : target;
  const space = ns ?? childNamespace(parent);
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) insert(target, item, place, space);
  } else if (isFunction(value)) {
    if (!at) createRegion(parent, value, place, space);
    else claimRegion(takeRegion(at), value, place, space);
  } else if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    if (at) claimText(at, String(value), place);
    else parent.append(place(document.createTextNode(String(value))));
  } else if (value instanceof Node) {
    if (at) fail(at, describe(value));
    else parent.append(place(value));
  } else if (value instanceof Lazy && at && value.created) {
    fail(at, "作成済みの値");
  } else if (value instanceof Deferred) {
    if (!at) parent.append(place(value.value(undefined, space)));
    else place(value.value(at, space));
  } else if (value instanceof DeferredRegion) {
    if (!at) createRegion(parent, value.value(undefined, space, place), place, space);
    else claimBoundary(takeRegion(at), value, place, space);
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
function createRegion(
  parent: ParentNode,
  value: () => unknown,
  place: (node: Node) => Node,
  ns: Namespace,
): void {
  const start = document.createComment(REGION_START);
  const end = document.createComment(REGION_END);
  parent.append(start, end);
  updateRegion(start, end, value, place, ns);
}

/**
 * `start` と `end` の間を、`value` の値が変化するたびに置換する。値がノードの配列なら、そのノードを並べる。配列の中の領域は、並べる時点の DOM の中身で並べる。
 * それ以外の値は、ノードにしてから並べる。並べるときは、領域の中のノードのうち新しい配列に無いものを削除し、
 * 残ったノードのうち、配列の順と同じ順に並んでいる最も長い列のノードは動かさずに、ほかのノードだけを移動する。
 * `first` があれば、最初の計算では `first` を呼び、`first` が `true` を返したら置換しない。
 */
function updateRegion(
  start: Comment,
  end: Comment,
  value: () => unknown,
  place: (node: Node) => Node,
  ns: Namespace,
  first?: () => boolean,
): void {
  let initial = first !== undefined;
  createRenderEffect(
    (): readonly Node[] | undefined => {
      if (initial) {
        initial = false;
        if (first?.()) return undefined;
      }
      const current = outsideScope(value);
      if (placed(start, end, current)) return undefined;
      if (Array.isArray(current) && current.every((item): item is Node => item instanceof Node)) {
        return current.map(place);
      }
      const fragment = document.createDocumentFragment();
      insert(fragment, current, place, ns);
      return [...fragment.childNodes];
    },
    (nodes) => {
      if (nodes !== undefined) rearrange(start, end, withRegions(nodes));
    },
  );
}

/** `nodes` のうち、領域の開始の目印から、対応する終了の目印までのノードを、今の DOM でその 2 つの目印の間にあるノードに置き換えた配列を返す。 */
function withRegions(nodes: readonly Node[]): Node[] {
  const result: Node[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    result.push(node);
    if (!isRegionMark(node, REGION_START)) continue;
    let depth = 1;
    let inner = node.nextSibling;
    for (; inner !== null; inner = inner.nextSibling) {
      result.push(inner);
      if (isRegionMark(inner, REGION_START)) depth++;
      else if (isRegionMark(inner, REGION_END) && --depth === 0) break;
    }
    if (inner === null) continue;
    while (index < nodes.length - 1 && nodes[index] !== inner) index++;
  }
  return result;
}

/** `node` が、内容が `mark` のコメントなら `true` を返す。 */
const isRegionMark = (node: Node, mark: string): boolean =>
  node instanceof Comment && node.data === mark;

/**
 * `start` と `end` の間のノードを `nodes` の順にする。`nodes` に無いノードを削除する。
 * 領域に残ったノードのうち、`nodes` と同じ順に並んでいる最も長い列のノードは動かさない。
 */
function rearrange(start: Comment, end: Comment, nodes: readonly Node[]): void {
  const kept = new Set(nodes);
  const positions = new Map<Node, number>();
  for (let node = start.nextSibling; node !== null && node !== end;) {
    const next = node.nextSibling;
    if (kept.has(node)) positions.set(node, positions.size);
    else node.remove();
    node = next;
  }
  const staying = increasing(nodes.map((node) => positions.get(node) ?? -1));
  const parent = end.parentNode;
  if (parent === null) return;
  let anchor: Node = end;
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index]!;
    if (!staying.has(index)) parent.insertBefore(node, anchor);
    anchor = node;
  }
}

/** `values` のうち 0 以上の値で作る最長増加部分列の、添字の集合を返す。 */
function increasing(values: readonly number[]): ReadonlySet<number> {
  // tails[k] は、長さが k + 1 の増加部分列の末尾のうち、値が最も小さいものの添字である
  const tails: number[] = [];
  const previous: number[] = [];
  values.forEach((value, index) => {
    if (value < 0) return;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[tails[middle]!]! < value) low = middle + 1;
      else high = middle;
    }
    previous[index] = low > 0 ? tails[low - 1]! : -1;
    tails[low] = index;
  });
  const result = new Set<number>();
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]!) result.add(index);
  return result;
}

/**
 * 引き取った領域で、最初の計算の値のノードを領域の中身から引き取る。
 * 最初の計算が投げたら、領域の SSR のノードを残し、値が変化したときに置換する。
 */
function claimRegion(
  region: Region | undefined,
  value: () => unknown,
  place: (node: Node) => Node,
  ns: Namespace,
): void {
  if (!region) return;
  const { start, end, inner } = region;
  updateRegion(start, end, value, place, ns, () => {
    claimWithin(inner, (within) => insert(within, outsideScope(value), place));
    return true;
  });
}

/**
 * 引き取った領域で、境界を作成する。境界の中身は、作成するときに領域の中身から引き取る。
 * サーバーが境界の中身を出力しなかった領域は、領域の中身を置換する。最初の値のノードが領域の中身と異なるときは、`onMismatch` に従う。
 * 最初の計算が投げたときは、領域の SSR のノードを残し、値が変化したときに置換する。
 */
function claimBoundary(
  region: Region | undefined,
  value: DeferredRegion,
  place: (node: Node) => Node,
  ns: Namespace,
): void {
  if (!region) return;
  const { start, end, inner } = region;
  const fresh = atServerFallback(inner);
  const made = value.value(fresh ? undefined : inner, ns, place);
  updateRegion(start, end, made, place, ns, () => {
    if (fresh) return false;
    if (!claiming(inner.hydration)) return true;
    return placed(start, end, outsideScope(made)) || value.onMismatch === "keep";
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
    return asClientNode(new Deferred((at, ns) => createTag(type, given, at, ns)));
  }
  return asClientNode(untrack(() => outsideScope(() => type(props))));
}

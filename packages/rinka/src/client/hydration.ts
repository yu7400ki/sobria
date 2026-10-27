import {
  BOUNDARY_ATTRIBUTE,
  FORM_VALUE_ATTRIBUTE,
  REGION_END,
  REGION_FALLBACK,
  REGION_START,
} from "../shared/attributes.ts";

/**
 * 1 つの要素の Shadow DOM を引き取る状態を表す。
 * `state` は、最初の描画の引き取りの最中なら `"claiming"`、引き取りを終えたら `"done"` である。引き取りに失敗したら、期待したノードと実際のノードを説明する文を `failure` に持つ。
 * `"done"` の後に再び実行した計算は、ノードを引き取らずに作成する。
 */
export interface Hydration {
  state: "claiming" | "done" | { readonly failure: string };
}

/**
 * 引き取りの位置を表す。`next` は `parent` の子のうち次に引き取るノードで、`until` は範囲の終わりのノードである。
 * `until` が `null` なら、`parent` の子の末尾までを範囲にする。
 */
export interface Cursor {
  readonly parent: ParentNode;
  next: ChildNode | null;
  readonly until: ChildNode | null;
  readonly hydration: Hydration;
}

/** 引き取りの状態を作成する。 */
export const createHydration = (): Hydration => ({ state: "claiming" });

/** 最初の描画の引き取りを終えたことを記録する。失敗していれば、失敗の状態のままにする。 */
export function complete(hydration: Hydration): void {
  if (claiming(hydration)) hydration.state = "done";
}

/** 引き取りの最中で、失敗していなければ `true` を返す。 */
export const claiming = (hydration: Hydration): boolean => hydration.state === "claiming";

/** 引き取りに失敗していれば、期待したノードと実際のノードを説明する文を返す。 */
export const failureOf = (hydration: Hydration): string | undefined =>
  typeof hydration.state === "object" ? hydration.state.failure : undefined;

/** `parent` の子を、`first` から子の末尾まで引き取る位置を作成する。 */
export const childCursor = (
  parent: ParentNode,
  hydration: Hydration,
  first: ChildNode | null = parent.firstChild,
): Cursor => ({ parent, next: first, until: null, hydration });

/** サーバーだけが出力し、クライアントが作成しないノードなら `true` を返す。 */
export const serverOnly = (node: Node): boolean =>
  node instanceof HTMLInputElement && node.hasAttribute(FORM_VALUE_ATTRIBUTE);

/** 次に引き取るノードを返す。サーバーだけが出力するノードは飛ばす。範囲の終わりに達していれば `null` を返す。 */
function peek(at: Cursor): ChildNode | null {
  while (at.next !== null && at.next !== at.until && serverOnly(at.next)) {
    at.next = at.next.nextSibling;
  }
  return at.next === at.until ? null : at.next;
}

/** `node` を説明する文を返す。 */
export function describe(node: Node | null): string {
  if (node === null) return "ノードの無い位置";
  if (node instanceof Element) return `<${node.localName}>`;
  if (node instanceof Text) return `テキスト ${JSON.stringify(node.data)}`;
  if (node instanceof Comment) return `コメント ${JSON.stringify(node.data)}`;
  return node.nodeName;
}

/** 引き取りに失敗したことを記録する。最初の失敗だけを記録する。 */
export function fail(at: Cursor, expected: string): void {
  if (!claiming(at.hydration)) return;
  at.hydration.state = {
    failure: `${expected}を引き取る位置に、${describe(peek(at))}がありました`,
  };
}

/** SSR した DOM を引き取る位置で、描画の内容を作成している途中かどうかである。 */
let hydrating = false;

/** SSR した DOM を引き取る位置で、描画の内容を作成している途中かどうかを返す。 */
export const isHydrating = (): boolean => hydrating;

/** `fn` を、SSR した DOM を引き取る位置で作成しているかどうかを `value` にして実行する。 */
export function withHydrating<T>(value: boolean, fn: () => T): T {
  const previous = hydrating;
  hydrating = value;
  try {
    return fn();
  } finally {
    hydrating = previous;
  }
}

/**
 * `at` の位置で `fill` を実行し、位置が範囲の終わりに達していなければ失敗にする。
 * 引き取りの最中で、失敗していなければ `true` を返す。
 */
export function claimWithin(at: Cursor, fill: (at: Cursor) => void): boolean {
  fill(at);
  if (peek(at) !== null) fail(at, "範囲の末尾");
  return claiming(at.hydration);
}

/**
 * Shadow DOM の先頭にある、サーバーが `css` の値から出力した `<style>` と `<link rel="stylesheet">` を返す。
 * サーバーは、描画した内容を領域の目印で囲んで、スタイルの後に出力する。
 */
export function serverStyles(shadow: ShadowRoot): Element[] {
  const styles: Element[] = [];
  for (const node of shadow.childNodes) {
    if (
      !(node instanceof Element) ||
      (node.localName !== "style" &&
        !(node.localName === "link" && node.getAttribute("rel") === "stylesheet"))
    )
      break;
    styles.push(node);
  }
  return styles;
}

/** Shadow DOM の子を、サーバーが出力したスタイルの後から子の末尾まで引き取る位置を作成する。 */
export function shadowCursor(shadow: ShadowRoot, hydration: Hydration): Cursor {
  const last = serverStyles(shadow).at(-1);
  return childCursor(shadow, hydration, last ? last.nextSibling : shadow.firstChild);
}

/** 位置にある `tag` の要素を引き取る。無ければ失敗にして、`undefined` を返す。 */
export function takeElement(at: Cursor, tag: string): Element | undefined {
  if (!claiming(at.hydration)) return undefined;
  const node = peek(at);
  if (node instanceof Element && node.localName === tag) {
    at.next = node.nextSibling;
    return node;
  }
  fail(at, `<${tag}>`);
  return undefined;
}

/** 引き取った領域を表す。`inner` は、領域の中身を引き取る位置である。 */
export interface Region {
  readonly start: Comment;
  readonly end: Comment;
  readonly inner: Cursor;
}

/**
 * 位置にある領域の開始の目印を引き取り、入れ子の目印を数えて、対応する終了の目印を探索する。位置は、終了の目印の次に進める。
 * 目印が無ければ失敗にして、`undefined` を返す。
 */
export function takeRegion(at: Cursor): Region | undefined {
  if (!claiming(at.hydration)) return undefined;
  const start = peek(at);
  if (!(start instanceof Comment) || start.data !== REGION_START) {
    fail(at, `領域の目印 ${JSON.stringify(REGION_START)}`);
    return undefined;
  }
  let depth = 0;
  for (let node = start.nextSibling; node !== null && node !== at.until; node = node.nextSibling) {
    if (!(node instanceof Comment)) continue;
    if (node.data === REGION_START) depth++;
    else if (node.data === REGION_END && depth-- === 0) {
      at.next = node.nextSibling;
      const inner = {
        parent: at.parent,
        next: start.nextSibling,
        until: node,
        hydration: at.hydration,
      };
      return { start, end: node, inner };
    }
  }
  fail(at, `領域の目印 ${JSON.stringify(REGION_END)}`);
  return undefined;
}

/**
 * 境界の領域の中身の先頭に、サーバーが境界の中身を出力しなかったことを表す目印があれば `true` を返す。
 * 目印は、中身を送らなかった後送りの境界の `<template>` と、`<Errored>` のフォールバックを出力した領域のコメントである。
 */
export const atServerFallback = (at: Cursor): boolean => {
  const node = peek(at);
  return (
    (node instanceof HTMLTemplateElement && node.hasAttribute(BOUNDARY_ATTRIBUTE)) ||
    (node instanceof Comment && node.data === REGION_FALLBACK)
  );
};

/**
 * 位置にあるテキストを引き取り、内容を `text` にする。位置のテキストが `text` で始まり、`text` より長ければ、分割して先頭を引き取る。
 * `text` が空なら、テキストを作成して位置の前に挿入する。
 */
export function takeText(at: Cursor, text: string): void {
  if (!claiming(at.hydration)) return;
  const node = peek(at);
  if (text === "") {
    at.parent.insertBefore(document.createTextNode(""), at.next);
    return;
  }
  if (node instanceof Text) {
    if (node.data.startsWith(text)) {
      if (node.data.length > text.length) node.splitText(text.length);
    } else {
      node.data = text;
    }
    at.next = node.nextSibling;
    return;
  }
  fail(at, `テキスト ${JSON.stringify(text)}`);
}

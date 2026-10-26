import {
  BOUNDARY_ATTRIBUTE,
  FORM_VALUE_ATTRIBUTE,
  REGION_END,
  REGION_FALLBACK,
  REGION_START,
} from "../shared/attributes.ts";

/** 1 つの要素の Shadow DOM を引き取る状態を表す。 */
export interface Hydration {
  /** 引き取りに失敗したときに、期待したノードと実際のノードを説明する文を持つ。 */
  failure: string | undefined;
  /** 引き取ったノードを持つ。 */
  readonly claimed: WeakSet<Node>;
  /** `build` が引き取りの最中に返したノードの列を持つ。 */
  readonly built: WeakSet<object>;
}

/** 引き取りの位置を表す。`next` は、`parent` の子のうち、次に引き取るノードである。 */
export interface Cursor {
  readonly parent: ParentNode;
  next: ChildNode | null;
  readonly hydration: Hydration;
}

let cursor: Cursor | undefined;

/** 引き取りの状態を作成する。 */
export const createHydration = (): Hydration => ({
  failure: undefined,
  claimed: new WeakSet(),
  built: new WeakSet(),
});

/** 今の引き取りの位置を返す。 */
export const currentCursor = (): Cursor | undefined => cursor;

/** `parent` に挿入する値を引き取るなら、今の位置を返す。 */
export const cursorOf = (parent: ParentNode): Cursor | undefined =>
  cursor?.parent === parent ? cursor : undefined;

/** 引き取りの位置を `at` にして `fn` を実行する。`at` が `undefined` なら、引き取らずに実行する。 */
export function within<T>(at: Cursor | undefined, fn: () => T): T {
  const previous = cursor;
  cursor = at;
  try {
    return fn();
  } finally {
    cursor = previous;
  }
}

/** `parent` の子を `first` から順に引き取りながら `fn` を実行する。`fn` の後に引き取っていないノードが残れば、失敗にする。 */
export function claimChildren<T>(
  parent: ParentNode,
  first: ChildNode | null,
  hydration: Hydration,
  fn: () => T,
): T {
  const at: Cursor = { parent, next: first, hydration };
  const result = within(at, fn);
  if (peek(at) !== null) fail(at, "子の末尾");
  return result;
}

/** サーバーだけが出力し、クライアントが作成しないノードなら `true` を返す。 */
export const serverOnly = (node: Node): boolean =>
  node instanceof HTMLInputElement && node.hasAttribute(FORM_VALUE_ATTRIBUTE);

/** 次に引き取るノードを返す。サーバーだけが出力するノードは飛ばす。 */
function peek(at: Cursor): ChildNode | null {
  while (at.next !== null && serverOnly(at.next)) at.next = at.next.nextSibling;
  return at.next;
}

/**
 * 境界の領域の開始の目印の直後で、サーバーが境界の中身を出力しなかったことを表す目印があれば `true` を返す。
 * 目印は、中身を送らなかった後送りの境界の `<template>` と、`<Errored>` のフォールバックを出力した領域のコメントである。
 */
export const atServerFallback = (at: Cursor): boolean => {
  const node = peek(at);
  return (
    (node instanceof HTMLTemplateElement && node.hasAttribute(BOUNDARY_ATTRIBUTE)) ||
    (node instanceof Comment && node.data === REGION_FALLBACK)
  );
};

/** `node` を説明する文を返す。 */
function describe(node: Node | null): string {
  if (node === null) return "ノードの無い位置";
  if (node instanceof Element) return `<${node.localName}>`;
  if (node instanceof Text) return `テキスト ${JSON.stringify(node.data)}`;
  if (node instanceof Comment) return `コメント ${JSON.stringify(node.data)}`;
  return node.nodeName;
}

/** 引き取りに失敗したことを記録する。最初の失敗だけを記録する。 */
export function fail(at: Cursor, expected: string): void {
  at.hydration.failure ??= `${expected}を引き取る位置に、${describe(peek(at))}がありました`;
}

/** 位置にあるノードを引き取って、位置を進める。 */
function take<T extends ChildNode>(at: Cursor, node: T): T {
  at.next = node.nextSibling;
  at.hydration.claimed.add(node);
  return node;
}

/** 位置にある `tag` の要素を引き取る。無ければ失敗にして、`undefined` を返す。 */
export function takeElement(at: Cursor, tag: string): Element | undefined {
  if (at.hydration.failure !== undefined) return undefined;
  const node = peek(at);
  if (node instanceof Element && node.localName === tag) return take(at, node);
  fail(at, `<${tag}>`);
  return undefined;
}

/** 位置にある、`mark` の領域の目印のコメントを引き取る。無ければ失敗にして、`undefined` を返す。 */
export function takeComment(
  at: Cursor,
  mark: typeof REGION_START | typeof REGION_END,
): Comment | undefined {
  if (at.hydration.failure !== undefined) return undefined;
  const node = peek(at);
  if (node instanceof Comment && node.data === mark) return take(at, node);
  fail(at, `領域の目印 ${JSON.stringify(mark)}`);
  return undefined;
}

/**
 * `start` の領域の終了の目印までの中身を引き取らずに残し、終了の目印を引き取る。
 * 入れ子の領域の目印を数えて、対応する終了の目印を探す。見つからなければ失敗にして、`undefined` を返す。
 */
export function skipRegion(at: Cursor, start: Comment): Comment | undefined {
  let depth = 0;
  for (let node = start.nextSibling; node !== null; node = node.nextSibling) {
    if (!(node instanceof Comment)) continue;
    if (node.data === REGION_START) depth++;
    else if (node.data === REGION_END && depth-- === 0) {
      at.next = node;
      return take(at, node);
    }
  }
  fail(at, "領域の終了の目印");
  return undefined;
}

/**
 * 位置にあるテキストを引き取り、内容を `text` にする。位置のテキストが `text` で始まり、`text` より長ければ、分割して先頭を引き取る。
 * `text` が空なら、テキストを作成して位置の前に挿入する。
 */
export function takeText(at: Cursor, text: string): void {
  if (at.hydration.failure !== undefined) return;
  const node = peek(at);
  if (text === "") {
    const empty = document.createTextNode("");
    at.parent.insertBefore(empty, node);
    at.hydration.claimed.add(empty);
    return;
  }
  if (node instanceof Text) {
    if (node.data.startsWith(text)) {
      if (node.data.length > text.length) node.splitText(text.length);
    } else {
      node.data = text;
    }
    take(at, node);
    return;
  }
  fail(at, `テキスト ${JSON.stringify(text)}`);
}

/** `node` が引き取ったノードでなければ、失敗にする。 */
export function claimNode(at: Cursor, node: Node): void {
  if (!at.hydration.claimed.has(node)) fail(at, describe(node));
}

/** `value` が、`build` が引き取りの最中に返したノードの列なら `true` を返す。 */
export const isBuilt = (hydration: Hydration, value: unknown): boolean =>
  typeof value === "object" && value !== null && hydration.built.has(value);

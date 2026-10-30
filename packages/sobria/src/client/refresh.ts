import { headKey } from "../shared/head.ts";
import { isPlainObject } from "../shared/objects.ts";
import type { Receiver } from "../shared/receiver.ts";
import {
  REFRESH_HEADER,
  sameDocument,
  type RefreshJson,
  type RefreshPage,
  type RefreshValues,
} from "../shared/refresh.ts";
import { PROPS_KEY, REFRESH_PROPS_KEY } from "../shared/transfer-keys.ts";
import type { RedirectJson } from "../shared/wire.ts";
import { morph } from "./morph.ts";

/** ページの描き直しを始めた回数である。 */
let startedCount = 0;

/** 反映した描き直しのうち、最も後に始まったものの番号である。 */
let reflectedOrder = 0;

/** 前回の描き直しで、`<html>` と `<body>` に設定した属性の名前である。 */
const applied = new WeakMap<Element, readonly string[]>();

/** 起動スクリプトの受け口を返す。起動スクリプトを読み込んでいないページでは、エラーを投げる。 */
function receiver(): Receiver {
  const store = globalThis.$sobria;
  if (!store) {
    throw new Error(
      "[sobria] refreshPage() は、sobria のサーバーが描画したページで呼び出してください。",
    );
  }
  return store;
}

/** `startRewrite` が返す、描き直しの結果を反映する関数を表す。 */
export type Reflect = (apply: () => void) => void;

/**
 * ページの描き直しを始め、その結果を `reflect` で反映する関数を返す。
 * 返した関数は、この描き直しより後に始まった描き直しを既に反映していれば、`reflect` を呼ばない。
 */
export function startRewrite(): Reflect {
  const order = ++startedCount;
  return (reflect) => {
    if (order < reflectedOrder) return;
    reflectedOrder = order;
    reflect();
  };
}

/** 描き直しを要求するリクエストのレスポンスを表す。`body` は、本文が JSON なら解析した値で、JSON でなければ `undefined` である。 */
export type Received =
  | { readonly kind: "redirect" }
  | { readonly kind: "response"; readonly response: Response; readonly body: unknown };

/** `headers` を付与し、リダイレクトを追跡せずに `url` にリクエストを送信する。 */
export async function sendRefresh(
  url: string | URL,
  headers: Readonly<Record<string, string>>,
  init: Omit<RequestInit, "headers" | "redirect"> = {},
): Promise<Received> {
  const response = await fetch(url, { ...init, headers, redirect: "manual" });
  if (response.type === "opaqueredirect") return { kind: "redirect" };
  const json = response.headers.get("content-type")?.startsWith("application/json") ?? false;
  return {
    kind: "response",
    response,
    body: json ? ((await response.json()) as unknown) : undefined,
  };
}

/**
 * 現在の URL をサーバーで描き直して、ページに反映する。
 * レスポンスがリダイレクトのときと、描き直しの JSON でないときは、ページを読み込み直す。
 * レスポンスが届く前に、後に始まった描き直しを反映していたら、このレスポンスは反映しない。
 */
export const refreshPage: RefreshPage = async () => {
  receiver();
  const reflect = startRewrite();
  const received = await sendRefresh(location.href, { [REFRESH_HEADER]: "1" });
  reflectPage(reflect, received.kind === "response" ? received.body : undefined);
};

/**
 * `startRewrite` が返した `reflect` で、`page` が描き直しの JSON ならページに反映してから `afterReflect` を呼び、そうでなければページを読み込み直す。
 * ページを読み込み直したら真を返す。
 */
export function reflectPage(reflect: Reflect, page: unknown, afterReflect?: () => void): boolean {
  let reloaded = false;
  reflect(() => {
    if (isRefreshJson(page)) {
      applyRefresh(page);
      afterReflect?.();
      return;
    }
    reloaded = true;
    location.reload();
  });
  return reloaded;
}

/**
 * 移動先を伝える JSON `body` を反映する。`reflect` があり、移動先が現在のページなら、`page` を反映してから `afterReflect` を呼び、それ以外では移動先に移動する。
 * `reflect` でページを読み込み直したときと、移動したときは真を返す。
 */
export function redirected(
  body: RedirectJson,
  page: unknown,
  endpoint: URL,
  reflect: Reflect | undefined,
  afterReflect?: () => void,
): boolean {
  const target = new URL(body.redirect, endpoint);
  if (reflect && sameDocument(target, new URL(location.href))) {
    return reflectPage(reflect, page, afterReflect);
  }
  location.assign(target);
  return true;
}

/** `value` が、描き直しのレスポンスの JSON かどうかを返す。 */
export const isRefreshJson = (value: unknown): value is RefreshJson =>
  isPlainObject(value) &&
  "head" in value &&
  typeof value.head === "string" &&
  "body" in value &&
  typeof value.body === "string" &&
  "data" in value &&
  isPlainObject(value.data) &&
  "elements" in value &&
  Array.isArray(value.elements) &&
  "doc" in value &&
  isPlainObject(value.doc);

/** 描き直しのレスポンスの `json` を、ページに反映する。起動スクリプトを読み込んでいないページでは、エラーを投げる。 */
export function applyRefresh(json: RefreshJson): void {
  const store = receiver();
  const props = new Map<string, object>();
  for (const [id, expression] of Object.entries(json.data)) {
    // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-call, typescript/no-unsafe-type-assertion
    const values = new Function(`return (${expression})`)() as RefreshValues;
    props.set(id, values[REFRESH_PROPS_KEY]);
    if (PROPS_KEY in values) store.d(id, { [PROPS_KEY]: values[PROPS_KEY] });
  }
  store.m(json.elements);
  applyHead(json.head);
  applyAttributes(document.documentElement, json.doc.html);
  applyAttributes(document.body, json.doc.body);
  morph(document.body, json.body, (host, id) => {
    Object.assign(host, props.get(id));
    delete store.v[id];
  });
}

/** `html` のタグを `<head>` に反映する。加えた `<script>` は実行する。 */
function applyHead(html: string): void {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const tag of Array.from(template.content.children)) {
    if (tag.localName === "title") {
      document.title = tag.textContent;
      continue;
    }
    const key = keyOf(tag);
    const same = [...document.head.children].find((existing) =>
      key === undefined ? existing.isEqualNode(tag) : keyOf(existing) === key,
    );
    if (key !== undefined && same !== undefined) same.replaceWith(tag);
    else if (same === undefined) document.head.append(runnable(tag));
  }
}

/** `tag` が `<script>` なら、同じ属性と中身を持つ、実行できる `<script>` を返す。ほかのタグはそのまま返す。 */
function runnable(tag: Element): Element {
  if (!(tag instanceof HTMLScriptElement)) return tag;
  const script = document.createElement("script");
  for (const { name, value } of tag.attributes) script.setAttribute(name, value);
  script.text = tag.text;
  return script;
}

/** `<head>` のタグのキーを返す。 */
const keyOf = (tag: Element): string | undefined =>
  headKey(tag.localName, (name) => tag.getAttribute(name));

/** `element` に `attributes` を設定し、前回の描き直しで設定して `attributes` に無い属性を削除する。 */
function applyAttributes(element: Element, attributes: Readonly<Record<string, string>>): void {
  for (const name of applied.get(element) ?? []) {
    if (!Object.hasOwn(attributes, name)) element.removeAttribute(name);
  }
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  applied.set(element, Object.keys(attributes));
}

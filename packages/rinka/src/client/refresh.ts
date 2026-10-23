import { headKey } from "../shared/head.ts";
import type { Receiver } from "../shared/receiver.ts";
import { REFRESH_HEADER, type RefreshJson, type RefreshPage } from "../shared/refresh.ts";
import { PROPS_KEY, REFRESH_PROPS_KEY } from "../shared/transfer-keys.ts";
import { morph } from "./morph.ts";

/** 最後に呼び出した `refreshPage()` が返した Promise である。 */
let latest: Promise<void> | undefined;

/** 前回の描き直しで、`<html>` と `<body>` に設定した属性の名前である。 */
const applied = new WeakMap<Element, readonly string[]>();

/** 起動スクリプトの受け口を返す。起動スクリプトを読み込んでいないページでは、エラーを投げる。 */
function receiver(): Receiver {
  const store = globalThis.$rinka;
  if (!store) {
    throw new Error(
      "[rinka] refreshPage() は、rinka のサーバーが描画したページで呼び出してください。",
    );
  }
  return store;
}

/**
 * 現在の URL をサーバーで描き直して、ページに反映する。
 * レスポンスがリダイレクトのときと、描き直しの JSON でないときは、ページを読み込み直す。
 * 反映する前に後の `refreshPage()` を呼び出したときは、後のレスポンスだけを反映し、後の反映が終わってから解決する。
 */
export const refreshPage: RefreshPage = async () => {
  receiver();
  const call: Promise<void> = fetch(location.href, {
    headers: { [REFRESH_HEADER]: "1" },
    redirect: "manual",
  }).then(async (response) => {
    const json = response.headers.get("content-type")?.startsWith("application/json") ?? false;
    if (latest !== call) return latest;
    if (response.type === "opaqueredirect" || !json) {
      location.reload();
      return undefined;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const body = (await response.json()) as RefreshJson;
    if (latest !== call) return latest;
    applyRefresh(body);
    return undefined;
  });
  latest = call;
  return call;
};

/** 描き直しのレスポンスの `data` の式を評価した、1 つのホストの props を表す。 */
interface RefreshValues {
  readonly [REFRESH_PROPS_KEY]: object;
  readonly [PROPS_KEY]?: unknown;
}

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

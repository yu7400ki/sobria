import { isPlainObject } from "./objects.ts";

/** 真偽値を `"true"` か `"false"` の文字列で出力する、列挙型の属性の名前を列挙する。 */
const enumerated: ReadonlySet<string> = new Set(["draggable", "spellcheck", "contenteditable"]);

/**
 * 属性に出力する値を返す。`false`、`null`、`undefined` と、値が真のキーが無い `class` のオブジェクトでは `null` を返す。
 * `true` は値の無い属性の `""` にする。`aria-*` と列挙型の属性の真偽値は、`"true"` か `"false"` にする。
 * `class` のプレーンなオブジェクトは、値が真のキーを空白で区切る。それ以外の値は文字列に変換する。
 */
export function attributeValue(name: string, value: unknown): string | null {
  if (typeof value === "boolean" && (name.startsWith("aria-") || enumerated.has(name))) {
    return String(value);
  }
  if (value === true) return "";
  if (value === false || value === null || value === undefined) return null;
  if (name === "class" && isPlainObject(value)) {
    const names = Object.entries(value)
      .filter(([, on]) => Boolean(on))
      .map(([key]) => key);
    return names.length === 0 ? null : names.join(" ");
  }
  // oxlint-disable-next-line typescript/no-base-to-string
  return String(value);
}

/** ネイティブのタグの `key` を出力する属性の名前である。 */
export const KEY_ATTRIBUTE = "data-ok";

/** 要素のホストの ID を出力する属性の名前である。 */
export const HOST_ATTRIBUTE = "data-oh";

/** ホストが起動の前に待つ値のキーを、空白で区切って出力する属性の名前である。 */
export const AWAITED_ATTRIBUTE = "data-om";

/** 後送りの境界が始まる位置に置く `<template>` に、境界の ID を出力する属性の名前である。 */
export const BOUNDARY_ATTRIBUTE = "data-ob";

/** 後送りの境界の終わりに置くコメントの、境界の ID の前の文字列である。 */
export const BOUNDARY_END = "/ob:";

/** 値が変化するたびに中身を置換する領域の、開始の目印のコメントの文字列である。 */
export const REGION_START = "[";

/** サーバーが `<Errored>` のフォールバックを出力した領域の、先頭に置く目印のコメントの文字列である。 */
export const REGION_FALLBACK = "!";

/** 値が変化するたびに中身を置換する領域の、終了の目印のコメントの文字列である。 */
export const REGION_END = "]";

/** 後送りにした境界の中身を入れて送る `<template>` に、境界の ID を出力する属性の名前である。 */
export const BOUNDARY_CONTENT_ATTRIBUTE = "data-os";

/** 境界の中で差し替える内容を入れて送る `<template>` に、差し替えの ID を出力する属性の名前である。 */
export const PATCH_ATTRIBUTE = "data-op";

/** ネイティブのタグに記述した props の名前から、属性の名前を返す。`key` は `KEY_ATTRIBUTE` になり、ほかの名前は変わらない。 */
export const tagAttributeName = (name: string): string => (name === "key" ? KEY_ATTRIBUTE : name);

/** インスタンスの起動のタイミングを指定する属性の名前である。 */
export const LOAD_ATTRIBUTE = "data-rinka-load";

/** サーバーが、要素の `internals` から出力した ARIA の属性の名前を、空白で区切って列挙する属性の名前である。 */
export const ARIA_ATTRIBUTE = "data-rinka-aria";

/** サーバーが、フォームの部品の Light DOM に出力した hidden input に付与する属性の名前である。 */
export const FORM_VALUE_ATTRIBUTE = "data-rinka-form";

/** プロパティとして設定する props を、SSR で出力する形を表す。`attribute` は属性、`text` はテキストの子、`option` は値が一致する子の `<option>` の `selected` として出力する。 */
export type PropertyOutput = "attribute" | "text" | "option";

/** ネイティブのタグで、プロパティとして設定する props の名前と、SSR で出力する形を、タグ名ごとに表す。 */
const tagProperties: ReadonlyMap<string, ReadonlyMap<string, PropertyOutput>> = new Map([
  [
    "input",
    new Map<string, PropertyOutput>([
      ["value", "attribute"],
      ["checked", "attribute"],
    ]),
  ],
  ["textarea", new Map<string, PropertyOutput>([["value", "text"]])],
  ["select", new Map<string, PropertyOutput>([["value", "option"]])],
  ["option", new Map<string, PropertyOutput>([["selected", "attribute"]])],
]);

/** プロパティとして設定する props が無いタグの表である。 */
const noProperties: ReadonlyMap<string, PropertyOutput> = new Map();

/** タグ名が `tag` のネイティブのタグで、プロパティとして設定する props の名前と、SSR で出力する形の表を返す。 */
export const propertiesOf = (tag: string): ReadonlyMap<string, PropertyOutput> =>
  tagProperties.get(tag) ?? noProperties;

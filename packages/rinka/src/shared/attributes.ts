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

/** 後送りの境界の開始の目印の `<template>` に、境界の ID を出力する属性の名前である。 */
export const BOUNDARY_ATTRIBUTE = "data-ob";

/** 後送りの境界の中身を運ぶ `<template>` に、境界の ID を出力する属性の名前である。 */
export const BOUNDARY_CONTENT_ATTRIBUTE = "data-os";

/** 境界の中の差し替えの中身を運ぶ `<template>` に、差し替えの ID を出力する属性の名前である。 */
export const PATCH_ATTRIBUTE = "data-op";

/** ネイティブのタグに記述した props の名前から、属性の名前を返す。`key` は `KEY_ATTRIBUTE` になり、ほかの名前は変わらない。 */
export const tagAttributeName = (name: string): string => (name === "key" ? KEY_ATTRIBUTE : name);

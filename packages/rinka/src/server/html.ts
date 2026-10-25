import { attributeValue } from "../shared/attributes.ts";

/** `text` を、HTML のテキストとして出力する文字列にする。 */
export const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** `text` を、HTML の二重引用符で囲んだ属性の値として出力する文字列にする。`&`、`"`、`<`、`>` を文字参照にする。 */
export const escapeAttribute = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** HTML の属性の名前として使用できる文字列に一致する正規表現である。 */
const attributeName = /^[^\s"'>/=\p{Cc}]+$/u;

/** 名前に属性の名前として使用できない文字があれば、エラーを投げる。 */
export function checkAttributeName(name: string): void {
  if (!attributeName.test(name)) {
    throw new Error(`属性の名前 ${JSON.stringify(name)} には、使用できない文字が含まれています。`);
  }
}

/**
 * 属性の出力の規則で、`value` を `name` の属性として出力する文字列を返す。`true` は値の無い属性にする。
 * 名前に属性の名前として使用できない文字があれば、エラーを投げる。
 */
export function attribute(name: string, value: unknown): string {
  checkAttributeName(name);
  const text = attributeValue(name, value);
  if (text === null) return "";
  return value === true && text === "" ? ` ${name}` : ` ${name}="${escapeAttribute(text)}"`;
}

/** URL `href` の CSS を読み込む `<link rel="stylesheet">` を返す。 */
export const stylesheetLink = (href: string): string =>
  `<link rel="stylesheet"${attribute("href", href)}>`;

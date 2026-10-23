/** `text` を、HTML のテキストとして出力する文字列にする。 */
export const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** `text` を、HTML の二重引用符で囲んだ属性の値として出力する文字列にする。 */
export const escapeAttribute = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

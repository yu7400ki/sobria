/** サーバーで ctx の `css` に渡すシートが、`<link>` に出力する情報を持つプロパティのキーである。 */
export const sheetInfo = Symbol.for("rinka.sheet");

/** サーバーのシートが持つ、`<link>` に出力する CSS の URL と、CSS に含まれる `@property` の規則である。 */
export interface SheetInfo {
  readonly href: string;
  readonly properties: string;
}

/** ctx の `css` を表す。タグ付きテンプレートか `CSSStyleSheet` を、呼び出した順に Shadow DOM に適用する。 */
export interface ElementCss {
  (strings: TemplateStringsArray, ...values: readonly (string | number)[]): void;
  (sheet: CSSStyleSheet): void;
}

/** タグ付きテンプレートの `strings` と `values` を連結した CSS を返す。 */
export const cssText = (
  strings: TemplateStringsArray,
  values: readonly (string | number)[],
): string => strings.reduce((text, part, index) => text + String(values[index - 1]) + part);

/** CSS `css` に含まれる `@property` の規則を、改行で区切って返す。 */
export const propertiesOf = (css: string): string =>
  (css.match(/@property\s[^{]*\{[^}]*\}/g) ?? []).join("\n");

/** ctx の `css` に渡した値が、タグ付きテンプレートの文字列の配列かどうかを返す。 */
export const isTemplate = (
  value: TemplateStringsArray | CSSStyleSheet,
): value is TemplateStringsArray => Array.isArray(value);

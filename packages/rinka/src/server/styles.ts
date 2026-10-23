import { PROPERTIES_ATTRIBUTE } from "../shared/attributes.ts";
import { cssText, isTemplate, propertiesOf, type ElementCss } from "../shared/styles.ts";
import { stylesheetLink } from "./html.ts";

/** サーバーで ctx の `css` に渡すシートが、`<link>` に出力する情報を持つプロパティのキーである。 */
export const sheetInfo = Symbol.for("rinka.sheet");

/** サーバーのシートが持つ、`<link>` に出力する CSS の URL と、CSS に含まれる `@property` の規則である。 */
export interface SheetInfo {
  readonly href: string;
  readonly properties: string;
}

/** サーバーで ctx の `css` に渡すシートを表す。 */
export interface ServerSheet {
  readonly [sheetInfo]: SheetInfo;
}

/** `<link>` に出力する URL `href` と、Vite が処理した CSS `css` から、サーバーで ctx の `css` に渡すシートを作成する。 */
export function serverSheet(href: string, css: string): ServerSheet {
  return { [sheetInfo]: { href, properties: propertiesOf(css) } };
}

/**
 * 渡したスタイルを、DSD の先頭に出力する HTML にして `styles` に、シートの情報を `sheets` に、呼び出した順に追加する ctx の `css` を返す。
 * タグ付きテンプレートは `<style>` に、シートは `<link rel="stylesheet">` にする。
 */
export function elementCss(styles: string[], sheets: SheetInfo[]): ElementCss {
  return (input: TemplateStringsArray | CSSStyleSheet, ...values: readonly (string | number)[]) => {
    if (isTemplate(input)) {
      styles.push(styleTag(cssText(input, values)));
      return;
    }
    const sheet = sheetOf(input);
    sheets.push(sheet);
    styles.push(stylesheetLink(sheet.href));
  };
}

/** `@property` の規則 `rules` を、ドキュメントに登録する `<style>` にする。 */
export const propertiesStyle = (rules: string): string =>
  styleTag(rules, ` ${PROPERTIES_ATTRIBUTE}`);

/** CSS `css` の `<style>` を返す。中の `</style` は、大文字と小文字を保ったまま `<\/style` に置換する。 */
const styleTag = (css: string, attributes = ""): string =>
  `<style${attributes}>${css.replaceAll(/<\/(style)/gi, "<\\/$1")}</style>`;

/** サーバーのシート `sheet` の情報を返す。Vite プラグインが生成したシートでなければ、エラーを投げる。 */
function sheetOf(sheet: CSSStyleSheet): SheetInfo {
  const info: unknown = Reflect.get(sheet, sheetInfo);
  if (info === undefined) {
    throw new Error(
      "[rinka] サーバーで css に渡せるシートは、with { type: 'css' } で import した CSS だけです。",
    );
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return info as SheetInfo;
}

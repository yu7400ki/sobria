import { cssText, isTemplate, type ElementCss } from "../shared/styles.ts";
import { stylesheetLink } from "./html.ts";

/** サーバーで ctx の `css` に渡すシートが、`<link>` に出力する CSS の URL を持つプロパティのキーである。 */
export const sheetHref = Symbol.for("sobria.sheet");

/** サーバーで ctx の `css` に渡すシートを表す。 */
export interface ServerSheet {
  readonly [sheetHref]: string;
}

/** `<link>` に出力する URL `href` から、サーバーで ctx の `css` に渡すシートを作成する。 */
export function serverSheet(href: string): ServerSheet {
  return { [sheetHref]: href };
}

/**
 * 渡したスタイルを、DSD の先頭に出力する HTML にして、呼び出した順に `styles` に追加する ctx の `css` を返す。
 * タグ付きテンプレートは `<style>` に、シートは `<link rel="stylesheet">` にする。
 */
export function elementCss(styles: string[]): ElementCss {
  return (input: TemplateStringsArray | CSSStyleSheet, ...values: readonly (string | number)[]) => {
    if (isTemplate(input)) {
      styles.push(styleTag(cssText(input, values)));
      return;
    }
    styles.push(stylesheetLink(hrefOf(input)));
  };
}

/** CSS `css` の `<style>` を返す。中の `</style` は、大文字と小文字を保ったまま `<\/style` に置換する。 */
const styleTag = (css: string): string =>
  `<style>${css.replaceAll(/<\/(style)/gi, "<\\/$1")}</style>`;

/** サーバーのシート `sheet` の、`<link>` に出力する CSS の URL を返す。Vite プラグインが生成したシートでなければ、エラーを投げる。 */
function hrefOf(sheet: CSSStyleSheet): string {
  const href: unknown = Reflect.get(sheet, sheetHref);
  if (typeof href !== "string") {
    throw new Error(
      "[sobria] サーバーで css に渡せるシートは、with { type: 'css' } で import した CSS だけです。",
    );
  }
  return href;
}

/** ルートのファイルごとの CSS の URL の一覧から、ページのルートのファイルの CSS の URL を、同じ URL を 1 回だけ含めて返す関数を作成する。 */
export const routeStyles =
  (table: Readonly<Record<string, readonly string[]>>) =>
  async (files: readonly string[]): Promise<readonly string[]> => [
    ...new Set(files.flatMap((file) => (Object.hasOwn(table, file) ? table[file]! : []))),
  ];

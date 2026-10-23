import { propertiesOf, sheetInfo, type SheetInfo } from "../shared/styles.ts";

/** `<link>` に出力する URL `href` と、Vite が処理した CSS `css` から、サーバーで ctx の `css` に渡すシートを作成する。 */
export function serverSheet(href: string, css: string): { readonly [sheetInfo]: SheetInfo } {
  return { [sheetInfo]: { href, properties: propertiesOf(css) } };
}

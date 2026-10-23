import { cssText, type ElementCss } from "../shared/styles.ts";

/** 埋め込む値の無いタグ付きテンプレートから作成したシートを、テンプレートごとに保持する。 */
const templateSheets = new WeakMap<TemplateStringsArray, CSSStyleSheet>();

/** 渡したシートを、呼び出した順に `sheets` に追加する ctx の `css` を返す。 */
export function elementCss(sheets: CSSStyleSheet[]): ElementCss {
  return (input: TemplateStringsArray | CSSStyleSheet, ...values: readonly (string | number)[]) => {
    sheets.push(input instanceof CSSStyleSheet ? input : templateSheet(input, values));
  };
}

/** タグ付きテンプレートのシートを返す。埋め込む値が無ければ、同じテンプレートには同じシートを返す。 */
function templateSheet(
  strings: TemplateStringsArray,
  values: readonly (string | number)[],
): CSSStyleSheet {
  const cached = values.length === 0 ? templateSheets.get(strings) : undefined;
  if (cached) return cached;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(cssText(strings, values));
  if (values.length === 0) templateSheets.set(strings, sheet);
  return sheet;
}

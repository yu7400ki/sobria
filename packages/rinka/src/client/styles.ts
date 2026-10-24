import { cssText, isTemplate, type ElementCss } from "../shared/styles.ts";

/** 埋め込む値の無いタグ付きテンプレートから作成したシートを、テンプレートごとに保持する。 */
const templateSheets = new WeakMap<TemplateStringsArray, CSSStyleSheet>();

/** 渡したシートを、呼び出した順に `sheets` に追加する ctx の `css` を返す。 */
export function elementCss(sheets: CSSStyleSheet[]): ElementCss {
  return (input: TemplateStringsArray | CSSStyleSheet, ...values: readonly (string | number)[]) => {
    sheets.push(isTemplate(input) ? templateSheet(input, values) : input);
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

/** URL `url` の CSS を取得してシートを作成する。 */
export async function loadSheet(url: string): Promise<CSSStyleSheet> {
  const response = await fetch(url);
  return createSheet(await response.text());
}

/** Vite が処理した CSS `css` からシートを作成する。 */
export function createSheet(css: string): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  updateSheet(sheet, css);
  return sheet;
}

/** シート `sheet` の中身を CSS `css` に差し替える。 */
export function updateSheet(sheet: CSSStyleSheet, css: string): void {
  sheet.replaceSync(css);
}

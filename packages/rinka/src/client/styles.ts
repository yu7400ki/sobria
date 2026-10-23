import { cssText, propertiesOf, type ElementCss } from "../shared/styles.ts";

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

/** ドキュメントに登録した `@property` の規則の組である。 */
const registered = new Set<string>();

/** Vite が処理した CSS `css` からシートを作成し、CSS の `@property` の規則をドキュメントに登録する。 */
export function createSheet(css: string): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  updateSheet(sheet, css);
  return sheet;
}

/** シート `sheet` の中身を CSS `css` に差し替え、CSS の `@property` の規則をドキュメントに登録する。 */
export function updateSheet(sheet: CSSStyleSheet, css: string): void {
  registerProperties(css);
  sheet.replaceSync(css);
}

/** CSS `css` に含まれる `@property` の規則を、ドキュメントのシートとして登録する。同じ CSS から抽出した規則の組は、1 回だけ登録する。 */
function registerProperties(css: string): void {
  const properties = propertiesOf(css);
  if (properties === "" || registered.has(properties)) return;
  registered.add(properties);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(properties);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

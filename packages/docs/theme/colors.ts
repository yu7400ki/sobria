import { defineSemanticTokens } from "@pandacss/dev";

/** ライトの値 `light` と、ダークの値 `dark` を持つ色を返す。どちらの値を使用するかは、色を使用する要素の `color-scheme` で決まる。 */
const scheme = (light: string, dark: string) => ({ value: `light-dark(${light}, ${dark})` });

/** サイトの役割ごとの色である。ライトは白地に青緑、ダークは暗い地に青緑である。 */
export const colors = defineSemanticTokens.colors({
  background: scheme("#fbfbf9", "#0e1116"),
  foreground: scheme("#22231f", "#d9dee7"),
  muted: {
    DEFAULT: scheme("#f1efe8", "#161b22"),
    foreground: scheme("#5f5e5a", "#8b93a3"),
  },
  border: scheme("#e2e1db", "#232833"),
  accent: {
    DEFAULT: scheme("#0f6e56", "#5dcaa5"),
    foreground: scheme("#ffffff", "#04342c"),
    subtle: scheme("#e1f5ee", "#0f2a24"),
    emphasis: scheme("#085041", "#9fe1cb"),
  },
});

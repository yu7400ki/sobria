import { defineSemanticTokens } from "@pandacss/dev";

/** サイトの役割ごとの色。ライトは白地の本文のページの色、ダークは暗い地に青緑の色である。 */
export const colors = defineSemanticTokens.colors({
  background: { value: { base: "#fbfbf9", _osDark: "#0e1116" } },
  foreground: { value: { base: "#22231f", _osDark: "#d9dee7" } },
  muted: {
    DEFAULT: { value: { base: "#f1efe8", _osDark: "#161b22" } },
    foreground: { value: { base: "#5f5e5a", _osDark: "#8b93a3" } },
  },
  border: { value: { base: "#e2e1db", _osDark: "#232833" } },
  accent: {
    DEFAULT: { value: { base: "#0f6e56", _osDark: "#5dcaa5" } },
    foreground: { value: { base: "#ffffff", _osDark: "#04342c" } },
    subtle: { value: { base: "#e1f5ee", _osDark: "#0f2a24" } },
    emphasis: { value: { base: "#085041", _osDark: "#9fe1cb" } },
  },
});

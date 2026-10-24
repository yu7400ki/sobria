import { defineTokens } from "@pandacss/dev";

export const fonts = defineTokens.fonts({
  sans: {
    value:
      "system-ui, -apple-system, 'Segoe UI', 'Hiragino Sans', 'Noto Sans JP', 'Meiryo', sans-serif",
  },
  mono: { value: "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace" },
});

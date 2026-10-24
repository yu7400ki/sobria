import { defineConfig, type Config } from "@pandacss/dev";

import { colors } from "./colors.ts";
import { fonts } from "./fonts.ts";
import { globalCss } from "./global-css.ts";

const config: Config = defineConfig({
  presets: ["@pandacss/preset-base", "@pandacss/preset-panda"],
  preflight: true,
  include: ["./src/**/*.{ts,tsx}"],
  exclude: [],
  outdir: "styled-system",
  globalCss,
  theme: {
    extend: {
      tokens: { fonts },
      semanticTokens: { colors },
    },
  },
});

export default config;

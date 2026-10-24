import { defineGlobalStyles, type Config } from "@pandacss/dev";

export const globalCss: Config["globalCss"] = {
  extend: defineGlobalStyles({
    html: { colorScheme: "light dark", fontFamily: "sans", lineHeight: "1.8" },
    body: { bg: "background", color: "foreground" },
  }),
};

import { defineGlobalStyles, type Config } from "@pandacss/dev";

/** Shiki が色付けした要素の、ライトとダークの文字の色である。 */
const shiki = { color: "light-dark(var(--shiki-light), var(--shiki-dark))" };

/** 本文の MDX から変換したタグのスタイルである。本文の要素の `markdown` のクラスの配下に適用する。 */
const markdown = {
  "& > * + *": { mt: "5" },
  "& h2": {
    mt: "12",
    pb: "2",
    fontSize: "2xl",
    fontWeight: "bold",
    borderBottomWidth: "1px",
    borderColor: "border",
  },
  "& h3": { mt: "8", fontSize: "xl", fontWeight: "bold" },
  "& h4": { mt: "6", fontWeight: "bold" },
  "& a": { color: "accent", textDecoration: "underline", textUnderlineOffset: "2px" },
  "& ul": { pl: "6", listStyleType: "disc" },
  "& ol": { pl: "6", listStyleType: "decimal" },
  "& li + li": { mt: "1" },
  "& blockquote": {
    pl: "4",
    borderLeftWidth: "4px",
    borderColor: "border",
    color: "muted.foreground",
  },
  "& :not(pre) > code": { px: "1", py: "0.5", rounded: "sm", bg: "muted", fontSize: "0.9em" },
  "& table": { display: "block", overflowX: "auto", borderCollapse: "collapse" },
  "& th, & td": { px: "3", py: "2", borderWidth: "1px", borderColor: "border" },
  "& th": { bg: "muted", fontWeight: "medium", textAlign: "left" },
  "& hr": { borderColor: "border" },
};

export const globalCss: Config["globalCss"] = {
  extend: defineGlobalStyles({
    html: { colorScheme: "light dark", fontFamily: "sans", lineHeight: "1.8" },
    ".dark": { colorScheme: "dark" },
    body: { minH: "100vh", bg: "background", color: "foreground" },
    "code, pre": { fontFamily: "mono" },
    ".shiki, .shiki span": shiki,
    ".markdown": markdown,
  }),
};

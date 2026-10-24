/** サイドバーの区分である。`slugs` は、区分に含める本文の、`src/content/` からのパスから拡張子を除いたものを、表示する順に列挙する。 */
export interface NavSection {
  readonly title: string;
  readonly slugs: readonly string[];
}

export const nav: readonly NavSection[] = [
  {
    title: "はじめに",
    slugs: ["introduction/what-is-rinka", "introduction/quick-start", "introduction/tutorial"],
  },
  {
    title: "ガイド",
    slugs: [
      "guide/routing",
      "guide/pages-and-data",
      "guide/elements",
      "guide/reactivity",
      "guide/loading",
      "guide/server-functions",
      "guide/forms",
      "guide/styling",
      "guide/hono",
      "guide/deploy",
      "guide/interop",
    ],
  },
  {
    title: "リファレンス",
    slugs: [
      "reference/api/rinka",
      "reference/api/server",
      "reference/api/router",
      "reference/api/vite",
      "reference/api/app",
      "reference/jsx",
      "reference/files",
      "reference/cli",
      "reference/glossary",
    ],
  },
];

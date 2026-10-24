/** サイドバーの区分である。`slugs` は、区分に含める本文の、`src/content/` からのパスから拡張子を除いたものを、表示する順に列挙する。 */
export interface NavSection {
  readonly title: string;
  readonly slugs: readonly string[];
}

export const nav: readonly NavSection[] = [
  { title: "はじめに", slugs: ["introduction/what-is-rinka", "introduction/quick-start"] },
];

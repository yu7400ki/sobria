import type { ServerNode } from "rinka";

import { nav } from "../content/nav.ts";

/** 本文の frontmatter である。 */
export interface Frontmatter {
  readonly title: string;
}

/** 目次の項目である。 */
export interface TocItem {
  readonly depth: number;
  readonly id: string;
  readonly text: string;
}

/** 本文の MDX のモジュールである。 */
export interface Content {
  readonly default: () => ServerNode;
  readonly frontmatter: Frontmatter;
  readonly toc: readonly TocItem[];
}

/** 本文の MDX の、`src/content/` からのパスである。 */
const CONTENT_DIR = "../content/";

/** 本文の slug から、モジュールを読み込む関数への対応である。 */
const modules = new Map(
  Object.entries(import.meta.glob<Content>("../content/**/*.mdx")).map(([path, load]) => [
    path.slice(CONTENT_DIR.length, -".mdx".length),
    load,
  ]),
);

/** サイドバーに表示する順の、すべての本文の slug である。 */
export const slugs: readonly string[] = nav.flatMap((section) => section.slugs);

for (const slug of slugs) {
  if (!modules.has(slug)) throw new Error(`nav.ts の ${slug} の本文が src/content/ にありません。`);
}
for (const slug of modules.keys()) {
  if (!slugs.includes(slug))
    throw new Error(`src/content/${slug}.mdx を nav.ts に記述してください。`);
}

/** slug が `slug` の本文を読み込む。本文が無ければ `undefined` を返す。frontmatter に `title` が無ければ、エラーを投げる。 */
export async function loadContent(slug: string): Promise<Content | undefined> {
  const load = modules.get(slug);
  if (load === undefined) return undefined;
  const content = await load();
  const title: unknown = content.frontmatter.title;
  if (typeof title !== "string")
    throw new Error(`src/content/${slug}.mdx の frontmatter に title を記述してください。`);
  return content;
}

/** すべての本文の slug から、題名への対応を返す。 */
export async function loadTitles(): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    slugs.map(async (slug) => [slug, (await loadContent(slug))!.frontmatter.title] as const),
  );
  return new Map(entries);
}

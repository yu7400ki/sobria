import type { ServerNode } from "rinka";
import { href } from "rinka/router";

import type { TocItem } from "../components/toc.tsx";
import { nav } from "../content/nav.ts";

/** 本文のページである。 */
export interface Page {
  readonly slug: string;
  readonly href: string;
  readonly title: string;
  readonly Body: () => ServerNode;
  readonly toc: readonly TocItem[];
}

/** サイドバーの区分である。 */
export interface Section {
  readonly title: string;
  readonly pages: readonly Page[];
}

/** MDX の変換が出力するモジュールである。 */
interface MdxModule {
  readonly default: () => ServerNode;
  readonly title: string;
  readonly toc: readonly TocItem[];
}

/** glob のキーのうち、slug の前にある部分である。キーは、このファイルからの相対パスである。 */
const KEY_PREFIX = "../content/";

/** 本文の slug から、MDX のモジュールへの対応である。 */
const modules = new Map(
  Object.entries(import.meta.glob<MdxModule>("../content/**/*.mdx", { eager: true })).map(
    ([key, module]) => [key.slice(KEY_PREFIX.length, -".mdx".length), module],
  ),
);

/** サイドバーの区分である。nav.ts の本文が src/content/ に無ければ、エラーを投げる。 */
export const sections: readonly Section[] = nav.map((section) => ({
  title: section.title,
  pages: section.slugs.map((slug) => {
    const module = modules.get(slug);
    if (module === undefined) {
      throw new Error(`nav.ts の ${slug} の本文が src/content/ にありません。`);
    }
    const { default: Body, title, toc } = module;
    return { slug, href: href("/[...slug]", { slug }), title, Body, toc };
  }),
}));

/** サイドバーに表示する順の、すべての本文のページである。 */
export const pages: readonly Page[] = sections.flatMap((section) => section.pages);

for (const slug of modules.keys()) {
  if (!pages.some((page) => page.slug === slug)) {
    throw new Error(`src/content/${slug}.mdx を nav.ts に記述してください。`);
  }
}

/** サイドバーの最初の本文のページである。 */
export const firstPage: Page = (() => {
  const [page] = pages;
  if (page === undefined) throw new Error("nav.ts に本文を 1 つ以上記述してください。");
  return page;
})();

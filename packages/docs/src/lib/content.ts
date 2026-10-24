import type { ServerNode } from "rinka";

import { nav } from "../content/nav.ts";

/** 目次の項目である。 */
export interface TocItem {
  readonly depth: number;
  readonly id: string;
  readonly text: string;
}

/** 本文である。`title` は frontmatter の題名である。 */
export interface Content {
  readonly Body: () => ServerNode;
  readonly title: string;
  readonly toc: readonly TocItem[];
}

/** サイドバーの区分と、区分に含める本文の slug と題名である。 */
export interface Section {
  readonly title: string;
  readonly pages: readonly { readonly slug: string; readonly title: string }[];
}

/** MDX の変換が出力するモジュールである。frontmatter は検査していない値である。 */
interface MdxModule {
  readonly default: () => ServerNode;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly toc: readonly TocItem[];
}

/** glob のキーのうち、slug の前にある部分である。キーは、このファイルからの相対パスである。 */
const KEY_PREFIX = "../content/";

/** 本文の slug から、モジュールを読み込む関数への対応である。 */
const modules = new Map(
  Object.entries(import.meta.glob<MdxModule>("../content/**/*.mdx")).map(([key, load]) => [
    key.slice(KEY_PREFIX.length, -".mdx".length),
    load,
  ]),
);

/** サイドバーの区分と、区分に含める本文の slug と、本文を読み込む関数である。nav.ts の本文が src/content/ に無ければ、エラーを投げる。 */
const sections = nav.map((section) => ({
  title: section.title,
  pages: section.slugs.map((slug) => {
    const load = modules.get(slug);
    if (load === undefined)
      throw new Error(`nav.ts の ${slug} の本文が src/content/ にありません。`);
    return { slug, load };
  }),
}));

/** サイドバーに表示する順の、すべての本文の slug である。 */
export const slugs: readonly string[] = sections.flatMap((section) =>
  section.pages.map((page) => page.slug),
);

for (const slug of modules.keys()) {
  if (!slugs.includes(slug))
    throw new Error(`src/content/${slug}.mdx を nav.ts に記述してください。`);
}

/** サイドバーの最初の本文の slug である。 */
export const firstSlug: string = (() => {
  const [slug] = slugs;
  if (slug === undefined) throw new Error("nav.ts に本文を 1 つ以上記述してください。");
  return slug;
})();

/** slug が `slug` の本文を `load` で読み込む。frontmatter に文字列の `title` が無ければ、エラーを投げる。 */
async function read(slug: string, load: () => Promise<MdxModule>): Promise<Content> {
  const { default: Body, frontmatter, toc } = await load();
  const { title } = frontmatter;
  if (typeof title !== "string")
    throw new Error(`src/content/${slug}.mdx の frontmatter に title を記述してください。`);
  return { Body, title, toc };
}

/** slug が `slug` の本文を読み込む。本文が無ければ `undefined` を返す。 */
export async function loadContent(slug: string): Promise<Content | undefined> {
  const load = modules.get(slug);
  return load && read(slug, load);
}

/** サイドバーの区分を、本文の題名とともに返す。 */
export async function loadSections(): Promise<readonly Section[]> {
  return Promise.all(
    sections.map(async (section) => ({
      title: section.title,
      pages: await Promise.all(
        section.pages.map(async ({ slug, load }) => ({
          slug,
          title: (await read(slug, load)).title,
        })),
      ),
    })),
  );
}

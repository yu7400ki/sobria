/// <reference types="vite/types/importMeta.d.ts" />
import type { ServerNode } from "rinka";
import type { PageProps, Prerender } from "rinka/router";
import { notFound } from "rinka/server";

/** 本文の MDX のモジュールである。 */
interface Content {
  readonly default: () => ServerNode;
  readonly frontmatter: { readonly title: string };
}

/** 本文の MDX のパスから、モジュールを読み込む関数への対応である。 */
const contents = import.meta.glob<Content>("../../content/**/*.mdx");

/** 本文の MDX のパスを、URL のパスの `slug` にする。 */
const slugOf = (path: string) => path.slice("../../content/".length, -".mdx".length);

export const prerender: Prerender<"/[...slug]"> = () =>
  Object.keys(contents).map((path) => ({ slug: slugOf(path) }));

export default async function Page({ params }: PageProps<"/[...slug]">) {
  const load = contents[`../../content/${params.slug}.mdx`];
  if (load === undefined) throw notFound();
  const { default: Body } = await load();
  return (
    <article>
      <Body />
    </article>
  );
}

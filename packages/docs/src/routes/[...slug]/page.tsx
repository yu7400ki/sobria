import { href, type PageProps, type Prerender } from "rinka/router";
import { notFound } from "rinka/server";
import { css } from "styled-system/css";

import Pager from "../../components/pager.tsx";
import Sidebar from "../../components/sidebar.tsx";
import Toc from "../../components/toc.tsx";
import { nav } from "../../content/nav.ts";
import { loadContent, loadTitles, slugs } from "../../lib/content.ts";

export const prerender: Prerender<"/[...slug]"> = () => slugs.map((slug) => ({ slug }));

/** slug が `slug` の本文の URL を返す。 */
const urlOf = (slug: string) => href("/[...slug]", { slug });

export default async function Page({ params }: PageProps<"/[...slug]">) {
  const content = await loadContent(params.slug);
  if (content === undefined) throw notFound();
  const titles = await loadTitles();
  const { default: Body, frontmatter, toc } = content;
  const sections = nav.map((section) => ({
    title: section.title,
    links: section.slugs.map((slug) => ({
      href: urlOf(slug),
      title: titles.get(slug)!,
      current: slug === params.slug,
    })),
  }));
  const index = slugs.indexOf(params.slug);
  const linkOf = (slug: string | undefined) =>
    slug === undefined ? undefined : { href: urlOf(slug), title: titles.get(slug)! };
  const sidebar = <Sidebar sections={sections} />;
  return (
    <div
      class={css({
        display: "grid",
        gridTemplateColumns: {
          base: "minmax(0, 1fr)",
          lg: "14rem minmax(0, 1fr)",
          xl: "14rem minmax(0, 1fr) 12rem",
        },
        gap: "10",
        maxW: "7xl",
        mx: "auto",
        px: "6",
        py: "10",
      })}
    >
      <title>{`${frontmatter.title} | rinka`}</title>
      <aside class={css({ display: { base: "none", lg: "block" } })}>
        <div class={css({ pos: "sticky", top: "10" })}>{sidebar}</div>
      </aside>
      <main>
        <details class={css({ display: { lg: "none" }, mb: "6" })}>
          <summary class={css({ cursor: "pointer", color: "muted.foreground", fontSize: "sm" })}>
            ページの一覧
          </summary>
          <div class={css({ mt: "4" })}>{sidebar}</div>
        </details>
        <h1 class={css({ fontSize: "3xl", fontWeight: "bold", mb: "8" })}>{frontmatter.title}</h1>
        <article class="markdown">
          <Body />
        </article>
        <Pager prev={linkOf(slugs[index - 1])} next={linkOf(slugs[index + 1])} />
      </main>
      <aside class={css({ display: { base: "none", xl: "block" } })}>
        {toc.length > 0 && (
          <div class={css({ pos: "sticky", top: "10" })}>
            <Toc items={toc} />
          </div>
        )}
      </aside>
    </div>
  );
}

import { href, type PageProps, type Prerender } from "rinka/router";
import { notFound } from "rinka/server";
import { css } from "styled-system/css";

import Pager from "../../components/pager.tsx";
import Sidebar from "../../components/sidebar.tsx";
import Toc from "../../components/toc.tsx";
import { loadContent, loadSections, slugs } from "../../lib/content.ts";

export const prerender: Prerender<"/[...slug]"> = () => slugs.map((slug) => ({ slug }));

/** 本文 `page` へのリンクを返す。 */
const linkOf = (page: { slug: string; title: string }) => ({
  href: href("/[...slug]", { slug: page.slug }),
  title: page.title,
});

export default async function Page({ params }: PageProps<"/[...slug]">) {
  const content = await loadContent(params.slug);
  if (content === undefined) throw notFound();
  const { Body, title, toc } = content;
  const loaded = await loadSections();
  const sections = loaded.map((section) => ({
    title: section.title,
    links: section.pages.map((page) => ({
      ...linkOf(page),
      current: page.slug === params.slug,
    })),
  }));
  const pages = loaded.flatMap((section) => section.pages);
  const index = pages.findIndex((page) => page.slug === params.slug);
  const prev = pages[index - 1];
  const next = pages[index + 1];
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
      <title>{`${title} | rinka`}</title>
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
        <h1 class={css({ fontSize: "3xl", fontWeight: "bold", mb: "8" })}>{title}</h1>
        <article class="markdown">
          <Body />
        </article>
        <Pager prev={prev && linkOf(prev)} next={next && linkOf(next)} />
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

import type { PageProps, Prerender } from "sobria/router";
import { notFound } from "sobria/server";
import { css } from "styled-system/css";

import Pager from "../../components/pager.tsx";
import Sidebar from "../../components/sidebar.tsx";
import Toc from "../../components/toc.tsx";
import { pages, sections } from "../content.ts";

export const prerender: Prerender<"/[...slug]"> = () => pages.map(({ slug }) => ({ slug }));

export default function Page({ params }: PageProps<"/[...slug]">) {
  const index = pages.findIndex((page) => page.slug === params.slug);
  const page = pages[index];
  if (page === undefined) throw notFound();
  const { Body, title, toc } = page;
  const prev = pages[index - 1];
  const next = pages[index + 1];
  const sidebar = <Sidebar sections={sections} currentHref={page.href} />;
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
      <title>{`${title} | sobria`}</title>
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
        <Pager prev={prev} next={next} />
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

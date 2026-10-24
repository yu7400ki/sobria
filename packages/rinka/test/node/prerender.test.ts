import { describe, expect, it } from "vitest";

import { prerenderTargets } from "../../src/server/prerender.ts";
import type { Route, Routes } from "../../src/shared/routes.ts";

/** `exports` を export するモジュールの、パターンが `pattern` のページの行を返す。ファイルは `src/routes<pattern>/page.tsx` である。 */
const pageRow = (pattern: string, exports: object = {}): Route => ({
  kind: "page",
  path: pattern,
  pattern,
  module: Object.assign(async () => ({ default: () => null, ...exports }), {
    file: `src/routes${pattern === "/" ? "" : pattern}/page.tsx`,
  }),
  layouts: [],
  middlewares: [],
});

/** `exports` を export するモジュールの、パターンが `pattern` の `route.ts` の行を返す。ファイルは `src/routes<pattern>/route.ts` である。 */
const routeRow = (pattern: string, exports: object): Route => ({
  kind: "route",
  path: pattern,
  pattern,
  module: Object.assign(async () => exports, { file: `src/routes${pattern}/route.ts` }),
  middlewares: [],
});

const table = (...routes: Route[]): Routes => ({ routes });

/** `route` だけの表の書き出しが、`file` を含むエラーになることを確認する。 */
const rejects = async (route: Route, file: string) =>
  expect(prerenderTargets(table(route), "all")).rejects.toThrow(file);

/** パラメータ `values` を返す `/users/[id]` のページの行を返す。 */
const user = (values: unknown[]) => pageRow("/users/[id]", { prerender: () => values });

/** キャッチオールの値 `path` を返す `/docs/[...path]` のページの行を返す。 */
const docs = (path: string) => pageRow("/docs/[...path]", { prerender: () => [{ path }] });

describe("prerenderTargets", () => {
  it("prerender が true のページと route.ts は、パターンの URL を、関数のページは戻り値のパラメータを埋めた URL を返す", async () => {
    const routes = table(
      pageRow("/about", { prerender: true }),
      pageRow("/posts/[slug]", { prerender: async () => [{ slug: "a b" }, { slug: 2 }] }),
      pageRow("/docs/[...path]", { prerender: () => [{ path: "x/y z" }] }),
      routeRow("/feed.xml", { GET: () => "", POST: () => "", prerender: true }),
      pageRow("/skipped"),
    );
    const scope = new Set([
      "src/routes/about/page.tsx",
      "src/routes/posts/[slug]/page.tsx",
      "src/routes/docs/[...path]/page.tsx",
      "src/routes/feed.xml/route.ts",
    ]);
    expect(await prerenderTargets(routes, scope)).toEqual([
      { kind: "page", file: "src/routes/about/page.tsx", urls: ["/about"] },
      {
        kind: "page",
        file: "src/routes/posts/[slug]/page.tsx",
        urls: ["/posts/a%20b", "/posts/2"],
      },
      { kind: "page", file: "src/routes/docs/[...path]/page.tsx", urls: ["/docs/x/y%20z"] },
      { kind: "route", file: "src/routes/feed.xml/route.ts", urls: ["/feed.xml"] },
    ]);
  });

  it("prerender の値がルートの形に合わなければ、ファイルを含むエラーを投げる", async () => {
    await Promise.all([
      rejects(pageRow("/users/[id]", { prerender: true }), "src/routes/users/[id]/page.tsx"),
      rejects(pageRow("/about", { prerender: () => [{}] }), "src/routes/about/page.tsx"),
      rejects(pageRow("/users/[id]", { prerender: () => "a" }), "src/routes/users/[id]/page.tsx"),
      rejects(
        routeRow("/feed.xml", { GET: () => "", prerender: () => [] }),
        "src/routes/feed.xml/route.ts",
      ),
      rejects(
        routeRow("/api/feed", { GET: () => "", prerender: true }),
        "src/routes/api/feed/route.ts",
      ),
      rejects(
        routeRow("/feeds/[id]/feed.xml", { GET: () => "", prerender: true }),
        "src/routes/feeds/[id]/feed.xml/route.ts",
      ),
    ]);
  });

  it("URL の区切りにできないパラメータの値と、重複した URL は、ファイルを含むエラーにする", async () => {
    await Promise.all([
      ...[
        [{ name: "a" }],
        [{ id: "" }],
        [{ id: "." }],
        [{ id: ".." }],
        [{ id: "a/b" }],
        [{ id: "c++" }],
        [{ id: "C:" }],
        [null],
      ].map(async (values) => rejects(user(values), "src/routes/users/[id]/page.tsx")),
      ...["a/../b", "a//b", "/a", "", "a/b?c"].map(async (path) =>
        rejects(docs(path), "src/routes/docs/[...path]/page.tsx"),
      ),
      expect(prerenderTargets(table(user([{ id: 1 }, { id: "1" }])), "all")).rejects.toThrow(
        "/users/1 のパラメータを 2 回返しました",
      ),
    ]);
  });

  it("scope が all なら、prerender の無いパラメータの無いページと GET だけの route.ts も返し、サーバーが必要な行はエラーにする", async () => {
    const routes = table(
      pageRow("/"),
      pageRow("/posts/[slug]", { prerender: () => [{ slug: "a" }] }),
      routeRow("/robots.txt", { GET: () => "" }),
    );
    expect(await prerenderTargets(routes, "all")).toEqual([
      { kind: "page", file: "src/routes/page.tsx", urls: ["/"] },
      { kind: "page", file: "src/routes/posts/[slug]/page.tsx", urls: ["/posts/a"] },
      { kind: "route", file: "src/routes/robots.txt/route.ts", urls: ["/robots.txt"] },
    ]);
    await Promise.all([
      rejects(pageRow("/users/[id]"), "src/routes/users/[id]/page.tsx"),
      rejects(
        routeRow("/robots.txt", { GET: () => "", POST: () => "" }),
        "src/routes/robots.txt/route.ts",
      ),
      rejects(
        routeRow("/feed.xml", { GET: () => "", POST: () => "", prerender: true }),
        "src/routes/feed.xml/route.ts",
      ),
      rejects(
        routeRow("/api/[id]/data.json", { GET: () => "" }),
        "src/routes/api/[id]/data.json/route.ts",
      ),
    ]);
  });
});

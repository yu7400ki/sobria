import { describe, expect, it } from "vitest";

import { prerenderTargets } from "../../src/server/prerender.ts";
import type { Route, Routes } from "../../src/shared/routes.ts";

/** `exports` を export するモジュールの、パターンが `pattern` のページの行を返す。 */
const pageRow = (pattern: string, exports: object = {}): Route => ({
  kind: "page",
  path: pattern,
  pattern,
  module: Object.assign(async () => ({ default: () => null, ...exports }), {
    file: `src/routes${pattern}/page.tsx`,
  }),
  layouts: [],
  middlewares: [],
});

/** `exports` を export するモジュールの、パターンが `pattern` の `route.ts` の行を返す。 */
const routeRow = (pattern: string, exports: object): Route => ({
  kind: "route",
  path: pattern,
  pattern,
  module: async () => exports,
  middlewares: [],
});

const table = (...routes: Route[]): Routes => ({ routes });

describe("prerenderTargets", () => {
  it("prerender が true のページと route.ts は、パターンの URL を、関数のページは戻り値のパラメータを埋めた URL を返す", async () => {
    const routes = table(
      pageRow("/about", { prerender: true }),
      pageRow("/posts/[slug]", { prerender: async () => [{ slug: "a b" }, { slug: 2 }] }),
      pageRow("/docs/[...path]", { prerender: () => [{ path: "x/y z" }] }),
      routeRow("/feed.xml", { GET: () => "", prerender: true }),
      pageRow("/skipped"),
    );
    expect(
      await prerenderTargets(
        routes,
        new Set(["/about", "/posts/[slug]", "/docs/[...path]", "/feed.xml"]),
      ),
    ).toEqual([
      { kind: "page", pattern: "/about", urls: ["/about"] },
      { kind: "page", pattern: "/posts/[slug]", urls: ["/posts/a%20b", "/posts/2"] },
      { kind: "page", pattern: "/docs/[...path]", urls: ["/docs/x/y%20z"] },
      { kind: "route", pattern: "/feed.xml", urls: ["/feed.xml"] },
    ]);
  });

  it("prerender の値がルートの形に合わなければ、パターンを含むエラーを投げる", async () => {
    const cases: [Route, string][] = [
      [pageRow("/users/[id]", { prerender: true }), "/users/[id]"],
      [pageRow("/about", { prerender: () => [{}] }), "/about"],
      [pageRow("/users/[id]", { prerender: () => [{ name: "a" }] }), "/users/[id]"],
      [pageRow("/users/[id]", { prerender: () => "a" }), "/users/[id]"],
      [routeRow("/feed.xml", { GET: () => "", prerender: () => [] }), "/feed.xml"],
      [routeRow("/api/feed", { GET: () => "", prerender: true }), "/api/feed"],
      [
        routeRow("/feeds/[id]/feed.xml", { GET: () => "", prerender: true }),
        "/feeds/[id]/feed.xml",
      ],
    ];
    await Promise.all(
      cases.map(async ([route, pattern]) =>
        expect(prerenderTargets(table(route), "all")).rejects.toThrow(pattern),
      ),
    );
  });

  it("scope が all なら、prerender の無いパラメータの無いページと GET だけの route.ts も返し、サーバーが必要な行はエラーにする", async () => {
    const routes = table(
      pageRow("/"),
      pageRow("/posts/[slug]", { prerender: () => [{ slug: "a" }] }),
      routeRow("/robots.txt", { GET: () => "" }),
    );
    expect(await prerenderTargets(routes, "all")).toEqual([
      { kind: "page", pattern: "/", urls: ["/"] },
      { kind: "page", pattern: "/posts/[slug]", urls: ["/posts/a"] },
      { kind: "route", pattern: "/robots.txt", urls: ["/robots.txt"] },
    ]);
    const servers: [Route, string][] = [
      [pageRow("/users/[id]"), "/users/[id]"],
      [routeRow("/robots.txt", { GET: () => "", POST: () => "" }), "/robots.txt"],
      [routeRow("/api/[id]/data.json", { GET: () => "" }), "/api/[id]/data.json"],
    ];
    await Promise.all(
      servers.map(async ([route, pattern]) =>
        expect(prerenderTargets(table(route), "all")).rejects.toThrow(pattern),
      ),
    );
  });
});

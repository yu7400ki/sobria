import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDevServer, originOf, stylesConfig } from "../dev-server.ts";
import { buildFixture } from "./production.ts";

const root = fileURLToPath(new URL("../fixtures/styles", import.meta.url));
let server: ViteDevServer;
let origin: string;

beforeAll(async () => {
  server = await createDevServer(root, { server: { port: 0 }, ...stylesConfig() });
  await server.listen();
  origin = originOf(server);
});

afterAll(async () => {
  await server.close();
});

/** 文書 `html` の `<head>` にある `<link rel="stylesheet">` の URL を、出現する順に返す。 */
const headLinks = (html: string): string[] =>
  [
    ...html.slice(0, html.indexOf("</head>")).matchAll(/<link rel="stylesheet" href="([^"]+)">/g),
  ].map((match) => match[1]!);

/** レイアウトが import した CSS の、開発サーバーの URL である。 */
const layoutLinks = [
  "/src/styles/theme.css?direct",
  "/src/styles/global.css?direct",
  "/src/styles/app.css?direct",
];

describe("要素のシート", () => {
  it("with { type: 'css' } で import したシートを、DSD の <link> に出力し、その URL を CSS として配信する", async () => {
    const html = await (await fetch(`${origin}/`)).text();
    expect(html).toContain(
      '<template shadowrootmode="open"><link rel="stylesheet" href="/src/styles/card.css?direct">',
    );
    const css = await fetch(`${origin}/src/styles/card.css?direct`);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain(".card");
  });

  it("クライアントのシートのモジュールは、?inline の CSS の更新を受け入れる", async () => {
    const client = server.environments.client;
    const css = `${root.replaceAll("\\", "/")}/src/styles/card.css`;
    await client.transformRequest(`\0sobria-sheet:${css}.js`);
    const inline = await client.moduleGraph.getModuleByUrl("/src/styles/card.css?inline");
    const importers = [...(inline?.importers ?? [])];
    expect(importers.some((node) => node.id?.includes("sobria-sheet"))).toBe(true);
    expect(importers.every((node) => [...node.acceptedHmrDeps].includes(inline!))).toBe(true);
  });
});

describe("サーバーコンポーネントの CSS", () => {
  it("レイアウトとページが import した CSS を、依存先を先に、同じ CSS を 1 回だけ、<head> の <link> に出力する", async () => {
    const html = await (await fetch(`${origin}/`)).text();
    expect(headLinks(html)).toEqual([...layoutLinks, "/src/routes/page.css?direct"]);
  });

  it("not-found.tsx と error.tsx のページには、そのページとレイアウトの CSS だけを出力し、notFound() やエラーを投げたページの CSS は出力しない", async () => {
    const responses = [];
    // not-found.tsx と error.tsx のモジュールを、最初のリクエストで読み込む場合を確認するため、URL を 1 つずつ取得する
    for (const path of ["/nope", "/gone", "/broken"]) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(`${origin}${path}`);
      // oxlint-disable-next-line no-await-in-loop
      responses.push([path, response.status, headLinks(await response.text())]);
    }
    expect(responses).toEqual([
      ["/nope", 404, [...layoutLinks, "/src/routes/not-found.css?direct"]],
      ["/gone", 404, [...layoutLinks, "/src/routes/not-found.css?direct"]],
      ["/broken", 500, [...layoutLinks, "/src/routes/error.css?direct"]],
    ]);
  });
});

describe("本番のビルドのエラーのページの CSS", () => {
  let outDir: string;
  let app: { fetch(request: Request): Response | Promise<Response> };

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "sobria-styles-"));
    await buildFixture(root, outDir, {}, stylesConfig().plugins);
    ({ default: app } = (await import(pathToFileURL(join(outDir, "server/entry.js")).href)) as {
      default: typeof app;
    });
  }, 120_000);

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  /** パス `path` のレスポンスのステータスと、`<head>` の `<link>` が指す CSS ファイルの内容を連結した文字列の組を返す。 */
  async function linkedCss(path: string): Promise<[number, string]> {
    const response = await app.fetch(new Request(new URL(path, "http://localhost")));
    const links = headLinks(await response.text());
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((link) => /^\/assets\/[^/]+\.css$/.test(link))).toBe(true);
    const css = await Promise.all(
      links.map((link) => readFile(join(outDir, "client", link), "utf8")),
    );
    return [response.status, css.join("\n")];
  }

  it("not-found.tsx と error.tsx のページには、そのページとレイアウトの CSS だけを出力し、notFound() やエラーを投げたページの CSS は出力しない", async () => {
    for (const path of ["/nope", "/gone"]) {
      // oxlint-disable-next-line no-await-in-loop
      const [status, css] = await linkedCss(path);
      expect(status).toBe(404);
      expect(css).toContain(".theme");
      expect(css).toContain(".not-found");
      expect(css).not.toContain(".gone");
    }
    const [status, css] = await linkedCss("/broken");
    expect(status).toBe(500);
    expect(css).toContain(".theme");
    expect(css).toContain(".failed");
    expect(css).not.toContain(".broken");
  });
});

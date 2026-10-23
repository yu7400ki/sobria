import { fileURLToPath } from "node:url";

import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDevServer, originOf, stylesConfig } from "../dev-server.ts";

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
    await client.transformRequest(`\0rinka-sheet:${css}.js`);
    const inline = await client.moduleGraph.getModuleByUrl("/src/styles/card.css?inline");
    const importers = [...(inline?.importers ?? [])];
    expect(importers.some((node) => node.id?.includes("rinka-sheet"))).toBe(true);
    expect(importers.every((node) => [...node.acceptedHmrDeps].includes(inline!))).toBe(true);
  });
});

describe("サーバーコンポーネントの CSS", () => {
  it("レイアウトとページが import した CSS を、依存先を先に、同じ CSS を 1 回だけ、<head> の <link> に出力する", async () => {
    const html = await (await fetch(`${origin}/`)).text();
    const head = html.slice(0, html.indexOf("</head>"));
    const links = [...head.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(
      (match) => match[1],
    );
    expect(links).toEqual([
      "/src/styles/theme.css?direct",
      "/src/styles/global.css?direct",
      "/src/styles/app.css?direct",
      "/src/routes/page.css?direct",
    ]);
  });
});

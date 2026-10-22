import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { rinka } from "rinka/vite";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../fixtures/basic", import.meta.url));

let server: ViteDevServer;
let origin: string;

beforeAll(async () => {
  server = await createServer({
    root,
    configFile: false,
    logLevel: "error",
    server: { port: 0, hmr: false },
    plugins: [rinka({ prefix: "app" })],
  });
  await server.listen();
  const address = server.httpServer?.address() as AddressInfo | null | undefined;
  if (!address) throw new Error("開発サーバーのアドレスを取得できません。");
  const { port } = address;
  origin = `http://localhost:${port}`;
});

afterAll(async () => {
  await server.close();
});

describe("開発サーバー", () => {
  it("src/routes の page.tsx を描画したページを返す", async () => {
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    const html = await response.text();
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<script type="module" src="/@vite/client"></script>');
    expect(html).toContain("<h1>basic</h1>");
    expect(html).toContain('<app-counter data-oh="h1"');
  });

  it("ページの無いパスには 404 を返す", async () => {
    const response = await fetch(`${origin}/missing`);
    expect(response.status).toBe(404);
  });

  it("Vite が処理するリクエストは、Vite が返す", async () => {
    const response = await fetch(`${origin}/src/elements/counter.tsx`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('__rinka_defineElement("app-counter"');
  });
});

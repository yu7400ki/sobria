import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "playwright";
import { rinka } from "rinka/vite";
import { preview, type PreviewServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDevServer, originOf } from "../dev-server.ts";
import { buildFixture } from "./production.ts";

/** TSX のソースの形のライブラリを使用するテスト用のアプリのルートである。 */
const root = fileURLToPath(new URL("../fixtures/library-app", import.meta.url));

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

/** `origin` の `/` を開き、ライブラリの要素が SSR した内容を持って起動し、共有スタイルとスロットが動作することを確認する。 */
async function checkPage(origin: string): Promise<void> {
  const html = await (await fetch(`${origin}/`)).text();
  expect(html).toMatch(/<acme-badge[^>]*><template shadowrootmode="open"/);
  expect(html).toContain("<app-badge");
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/`);
    await page.waitForSelector("acme-badge[data-started]");
    const result = await page.evaluate(() => {
      const shadow = document.querySelector("acme-badge")!.shadowRoot!;
      return {
        color: getComputedStyle(shadow.querySelector(".badge")!).color,
        slotted: shadow
          .querySelector("slot")!
          .assignedNodes()
          .map((node) => node.textContent),
      };
    });
    expect(result).toEqual({ color: "rgb(0, 128, 0)", slotted: ["slotted"] });
  } finally {
    await page.close();
  }
}

describe("TSX のソースの形のライブラリ", () => {
  it("開発サーバーで、ライブラリの要素を SSR し、クライアントで起動する", async () => {
    const server: ViteDevServer = await createDevServer(root, {
      server: { port: 0 },
      cacheDir: fileURLToPath(new URL("../node_modules/.vite/library-app", import.meta.url)),
    });
    try {
      await server.listen();
      await checkPage(originOf(server));
    } finally {
      await server.close();
    }
  }, 60_000);

  it("本番のビルドで、ライブラリの要素を SSR し、クライアントで起動する", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "rinka-library-app-"));
    let server: PreviewServer | undefined;
    try {
      await buildFixture(root, outDir);
      server = await preview({
        root,
        configFile: false,
        logLevel: "error",
        plugins: [rinka({ prefix: "app", outDir })],
        preview: { port: 0 },
      });
      await checkPage(server.resolvedUrls!.local[0]!.replace(/\/$/, ""));
    } finally {
      await server?.close();
      await rm(outDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("アプリの要素とライブラリの要素のタグが重なると、エラーを投げる", async () => {
    await expect(createDevServer(root, { plugins: [rinka({ prefix: "acme" })] })).rejects.toThrow(
      /acme-badge/,
    );
  });
});

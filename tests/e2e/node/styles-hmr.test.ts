import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "playwright";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createDevServer, originOf, stylesConfig } from "../dev-server.ts";

const root = fileURLToPath(new URL("../fixtures/styles", import.meta.url));
const file = fileURLToPath(new URL("../fixtures/styles/src/styles/hot.css", import.meta.url));
const original = await readFile(file, "utf8");
let server: ViteDevServer;
let browser: Browser;

beforeAll(async () => {
  server = await createDevServer(root, {
    server: { port: 0, hmr: true },
    cacheDir: fileURLToPath(new URL("../node_modules/.vite/node-styles-hmr", import.meta.url)),
    ...stylesConfig(),
  });
  await server.listen();
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await writeFile(file, original);
  await browser?.close();
  await server?.close();
});

it("要素が取り込んだ CSS を書き換えると、再読み込みせずに、同じシートの中身を差し替える", async () => {
  const page = await browser.newPage();
  await page.goto(`${originOf(server)}/hot`);
  await page.waitForSelector("app-hot[data-started]");
  const color = () =>
    page.evaluate(() => {
      const host = document.querySelector("app-hot")!;
      return getComputedStyle(host.shadowRoot!.querySelector(".hot")!).color;
    });
  expect(await color()).toBe("rgb(0, 128, 0)");
  await page.evaluate(() => {
    const host = document.querySelector("app-hot")!;
    Object.assign(window, { sheet: host.shadowRoot!.adoptedStyleSheets[0], kept: true });
  });
  await writeFile(file, original.replace("rgb(0, 128, 0)", "rgb(128, 0, 128)"));
  await expect.poll(color, { timeout: 10_000 }).toBe("rgb(128, 0, 128)");
  expect(
    await page.evaluate(() => {
      const host = document.querySelector("app-hot")!;
      const state = window as unknown as { sheet: CSSStyleSheet; kept: boolean };
      return [state.kept, host.shadowRoot!.adoptedStyleSheets[0] === state.sheet];
    }),
  ).toEqual([true, true]);
});

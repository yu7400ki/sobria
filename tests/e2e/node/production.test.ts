import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createDevServer, originOf, stylesConfig } from "../dev-server.ts";
import { buildFixture, startServer, type RunningServer } from "./production.ts";

/** テスト用のアプリ `fixtures/<name>` のルートを返す。 */
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

let outDir: string;
let deploy: RunningServer;
let styles: RunningServer;
let stylesDev: ViteDevServer;
let browser: Browser;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "rinka-production-"));
  await buildFixture(fixture("deploy"), join(outDir, "deploy"));
  await buildFixture(fixture("styles"), join(outDir, "styles"), {}, stylesConfig().plugins);
  deploy = await startServer(process.execPath, () => [join(outDir, "deploy/server/entry.js")]);
  styles = await startServer(process.execPath, () => [join(outDir, "styles/server/entry.js")]);
  stylesDev = await createDevServer(fixture("styles"), {
    server: { port: 0 },
    cacheDir: fileURLToPath(new URL("../node_modules/.vite/node-production", import.meta.url)),
    ...stylesConfig(),
  });
  await stylesDev.listen();
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await Promise.all([deploy?.stop(), styles?.stop()]);
  await stylesDev?.close();
  await browser?.close();
  await rm(outDir, { recursive: true, force: true });
});

/** `url` のページを開き、`selector` の要素が起動するまで待つ。 */
async function open(url: string, selector: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForSelector(`${selector}[data-started]`);
  return page;
}

it("本番のビルドのページでは、要素が起動し、シートを適用して、値の引き継ぎと RPC が動作する", async () => {
  const page = await open(`${deploy.origin}/`, "app-counter");
  const count = page.locator("app-counter .count");
  expect(await count.evaluate((button) => getComputedStyle(button).color)).toBe("rgb(255, 0, 0)");
  expect(await count.textContent()).toBe("2");
  await count.click();
  await expect.poll(() => count.textContent()).toBe("3");
  await page.locator("app-counter .ping").click();
  await expect.poll(() => page.locator("app-counter .ping").textContent()).toBe("pong");
  await page.close();
});

/** styles のテスト用のアプリの `/` を開き、ページと要素の見た目を表す値を返す。 */
async function looks(origin: string): Promise<string[]> {
  const page = await open(`${origin}/`, "app-card");
  await page.waitForSelector("app-badge[data-started]");
  const values = await page.evaluate(() => {
    const card = document.querySelector("app-card")!.shadowRoot!.querySelector(".card")!;
    const badge = document.querySelector("app-badge")!.shadowRoot!.querySelector("span")!;
    const main = document.querySelector("main")!;
    return [
      getComputedStyle(main).marginTop,
      getComputedStyle(main).paddingTop,
      getComputedStyle(document.body).marginTop,
      getComputedStyle(card).color,
      getComputedStyle(card).marginTop,
      getComputedStyle(badge).paddingTop,
      getComputedStyle(badge).rotate,
      getComputedStyle(badge).boxShadow,
    ];
  });
  await page.close();
  return values;
}

it("Tailwind v4 を使用するテスト用のアプリのページは、開発と本番のビルドで同じ見た目になる", async () => {
  const development = await looks(originOf(stylesDev));
  expect(development.slice(0, 3)).toEqual(["16px", "5px", "3px"]);
  expect(await looks(styles.origin)).toEqual(development);
}, 60_000);

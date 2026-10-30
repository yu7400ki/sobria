import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "playwright";
import { sobria, type SobriaOptions } from "sobria/vite";
import { preview, resolveConfig, type Plugin, type PreviewServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createDevServer, originOf } from "../dev-server.ts";
import { buildFixture } from "./production.ts";

/** テスト用のアプリ `fixtures/<name>` のルートを返す。 */
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** テストのアプリを配置するパスである。 */
const base = "/sub/";

let outDir: string;
let deploy: PreviewServer;
let prerendered: PreviewServer;
let dev: ViteDevServer;
let browser: Browser;

/** `root` のアプリを、sobria のプラグインの設定 `options` と `base` で `out` にビルドしたものを、`vite preview` で配信する。 */
async function previewOf(
  root: string,
  out: string,
  options: SobriaOptions = {},
): Promise<PreviewServer> {
  await buildFixture(root, out, options, [], { base });
  return preview({
    root,
    base,
    configFile: false,
    logLevel: "error",
    plugins: [sobria({ prefix: "app", outDir: out, ...options })],
    preview: { port: 0 },
  });
}

/** `preview` のサーバーのオリジンを返す。 */
const previewOrigin = (server: PreviewServer) => new URL(server.resolvedUrls!.local[0]!).origin;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "sobria-base-"));
  deploy = await previewOf(fixture("deploy"), join(outDir, "deploy"));
  prerendered = await previewOf(fixture("prerender"), join(outDir, "prerender"), {
    output: "static",
  });
  dev = await createDevServer(fixture("deploy"), {
    base,
    server: { port: 0 },
    cacheDir: fileURLToPath(new URL("../node_modules/.vite/node-base", import.meta.url)),
  });
  await dev.listen();
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await Promise.all([deploy?.close(), prerendered?.close(), dev?.close(), browser?.close()]);
  await rm(outDir, { recursive: true, force: true });
});

it.each([
  ["本番のビルド", () => previewOrigin(deploy)],
  ["開発サーバー", () => originOf(dev)],
])(
  "%s で base の下のページを開くと、シートを適用し、要素が起動して、RPC とフォームの送信が動作する",
  async (_name, origin) => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin()}${base}`);
      await page.waitForSelector("app-counter[data-started]");
      expect(await page.locator("h1").evaluate((h1) => getComputedStyle(h1).color)).toBe(
        "rgb(0, 0, 255)",
      );
      const count = page.locator("app-counter .count");
      expect(await count.evaluate((button) => getComputedStyle(button).color)).toBe(
        "rgb(255, 0, 0)",
      );
      await count.click();
      await expect.poll(() => count.textContent()).toBe("3");
      await page.locator("app-counter .ping").click();
      await expect.poll(() => page.locator("app-counter .ping").textContent()).toBe("pong");
      // フォームの送信の後は、読み込み直さずにページを描き直すので、要素の状態が残る
      const title = page.locator("form input[name=title]");
      await title.fill("x");
      const [submitted] = await Promise.all([
        page.waitForResponse((response) => response.request().method() === "POST"),
        title.press("Enter"),
      ]);
      expect([submitted.url(), submitted.status()]).toEqual([`${origin()}${base}`, 200]);
      expect(await submitted.json()).not.toHaveProperty("redirect");
      expect(await count.textContent()).toBe("3");
    } finally {
      await page.close();
    }
  },
  60_000,
);

it("書き出しは base を付けた URL で描画したページを、base を除いたパスに保存し、preview は base の下でそのファイルを返す", async () => {
  const client = join(outDir, "prerender/client");
  const about = await readFile(join(client, "about/index.html"), "utf8");
  expect(about).toContain("<h1>about</h1>");
  expect(await readFile(join(client, "404.html"), "utf8")).toContain("<h1>missing</h1>");
  const response = await fetch(`${previewOrigin(prerendered)}${base}about`);
  expect([response.status, await response.text()]).toEqual([200, about]);
  const missing = await fetch(`${previewOrigin(prerendered)}${base}nope`);
  expect(missing.status).toBe(404);
});

it.each([
  ["/sub", "/sub/"],
  ["/my app", "/my%20app/"],
  ["/a/../sub/", "/sub/"],
])(
  "base に %j を指定すると、ビルドと開発サーバーの import.meta.env.BASE_URL は %j になる",
  async (value, expected) => {
    const values = await Promise.all(
      (["build", "serve"] as const).map(async (command) => {
        const config = await resolveConfig(
          {
            root: fixture("basic"),
            base: value,
            configFile: false,
            logLevel: "silent",
            plugins: [sobria({ prefix: "app" })],
          },
          command,
        );
        return config.env["BASE_URL"] as unknown;
      }),
    );
    expect(values).toEqual([expected, expected]);
  },
);

/** base の `value` と、sobria のプラグインの後に登録する `plugins` で、ビルドの設定を解決する。 */
const resolveWith = (value: string, plugins: Plugin[] = []) =>
  resolveConfig(
    {
      root: fixture("basic"),
      base: value,
      configFile: false,
      logLevel: "silent",
      plugins: [sobria({ prefix: "app" }), ...plugins],
    },
    "build",
  );

it("sobria のプラグインより後のプラグインが、末尾に / の無い base に変更すると、エラーにする", async () => {
  await expect(
    resolveWith("/sub/", [{ name: "test:base", config: () => ({ base: "/other" }) }]),
  ).rejects.toThrow('Vite の base が "/other" です');
});

it("sobria のプラグインより後のプラグインが、Vitest のように base を / に変更すると、開発サーバーが出力する URL もその値で始まる", async () => {
  const server = await createDevServer(fixture("deploy"), {
    base: "/sub/",
    server: { port: 0 },
    cacheDir: fileURLToPath(new URL("../node_modules/.vite/node-base-post", import.meta.url)),
    plugins: [
      {
        name: "test:base",
        enforce: "post",
        config: { order: "post", handler: () => ({ base: "/" }) },
      },
    ],
  });
  try {
    await server.listen();
    const html = await (await fetch(`${originOf(server)}/`)).text();
    expect(html).toContain('src="/@vite/client"');
  } finally {
    await server.close();
  }
});

it.each(["/.//foo", "/a/..//foo"])(
  "区切りを解決すると // で始まる base の %j をエラーにする",
  async (value) => {
    await expect(resolveWith(value)).rejects.toThrow("Vite の base には");
  },
);

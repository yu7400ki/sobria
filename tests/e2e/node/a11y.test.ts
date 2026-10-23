import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDevServer, originOf } from "../dev-server.ts";

const root = fileURLToPath(new URL("../fixtures/basic", import.meta.url));
const axe = await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

let server: ViteDevServer;
let origin: string;
let browser: Browser;

beforeAll(async () => {
  // ほかのテストの開発サーバーと依存の事前バンドルを共有しないように、キャッシュのディレクトリを分ける
  server = await createDevServer(root, {
    server: { port: 0 },
    cacheDir: fileURLToPath(new URL("../node_modules/.vite/node-a11y", import.meta.url)),
  });
  await server.listen();
  origin = originOf(server);
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * `path` のページを開く。`js` が真なら、要素が起動して `data-rinka-aria` を持つ要素が無くなるまで待つ。
 * `js` が偽なら、サーバーの HTML からスクリプトと modulepreload を除いたページを開く。axe-core を実行するので、ブラウザの JS は有効にしたままにする。
 */
async function open(path: string, js: boolean): Promise<Page> {
  const page = await browser.newPage();
  if (!js) {
    const html = (await (await fetch(origin + path)).text())
      .replaceAll(/<script\b[\s\S]*?<\/script>/g, "")
      .replaceAll(/<link\b[^>]*\brel="modulepreload"[^>]*>/g, "");
    await page.route(origin + path, (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: html }),
    );
  }
  await page.goto(origin + path, { waitUntil: "load" });
  if (js) {
    await page.waitForFunction(() => document.querySelector("[data-rinka-aria]") === null, null, {
      timeout: 10_000,
    });
  }
  return page;
}

/** axe-core が報告した違反を、`影響 規則: 対象` の形で返す。 */
async function violations(page: Page): Promise<string[]> {
  await page.evaluate(axe);
  const result = await page.evaluate(async () => {
    const run = (
      window as unknown as {
        axe: { run: (context: Document, options: object) => Promise<unknown> };
      }
    ).axe.run;
    return run(document, { resultTypes: ["violations"] });
  });
  const { violations: found } = result as {
    violations: { id: string; impact: string; nodes: { target: string[] }[] }[];
  };
  return found.map(
    (violation) =>
      `${violation.impact} ${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
  );
}

/** Chromium のアクセシビリティツリーの、ロール、名前、無効の状態を返す。 */
async function accessibilityTree(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
    nodes: {
      role?: { value: string };
      name?: { value: string };
      properties?: { name: string; value: { value: unknown } }[];
    }[];
  };
  return nodes.map((node) => ({
    role: node.role?.value,
    name: node.name?.value,
    disabled:
      node.properties?.some(
        (property) => property.name === "disabled" && property.value.value === true,
      ) ?? false,
  }));
}

describe("アクセシビリティ", () => {
  for (const js of [true, false]) {
    const mode = js ? "JS がある" : "JS が無い";

    it(`${mode}ときに、フォームの部品のページで axe-core が違反を報告しない`, async () => {
      const page = await open("/review", js);
      try {
        expect(await violations(page)).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60_000);

    it(`${mode}ときに、<label for> がフォームの部品に名前を付け、<fieldset disabled> の中の部品を無効にする`, async () => {
      const page = await open("/review", js);
      try {
        const tree = await accessibilityTree(page);
        const groups = tree.filter((node) => node.role === "radiogroup");
        expect(groups.map((node) => node.name)).toHaveLength(2);
        expect(groups.map((node) => node.name)).toEqual(
          expect.arrayContaining(["score", "locked score"]),
        );
        const first = tree.filter((node) => node.role === "radio" && node.name === "1 / 5");
        expect(first.map((node) => node.disabled)).toHaveLength(2);
        expect(first.map((node) => node.disabled)).toEqual(expect.arrayContaining([false, true]));
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});

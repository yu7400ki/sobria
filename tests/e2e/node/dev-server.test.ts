import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDevServer, originOf } from "../dev-server.ts";

const root = fileURLToPath(new URL("../fixtures/basic", import.meta.url));

/** パスの区切りを `/` にする。 */
const posix = (path: string) => path.split(sep).join("/");

let server: ViteDevServer;
let origin: string;

beforeAll(async () => {
  server = await createDevServer(root, { server: { port: 0 } });
  await server.listen();
  origin = originOf(server);
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

  it("ページの描画で投げたエラーは、Vite のエラーの処理に渡す", async () => {
    const response = await fetch(`${origin}/boom`);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toBe("Internal Server Error");
    expect(body).toContain("ページの描画に失敗しました");
  });

  it("サーバー関数のエンドポイントは、変換の時点でサーバー関数の定義を見つけたモジュールだけを読み込む", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rinka-probe-"));
    try {
      const marker = join(dir, "marker.txt");
      const payload = join(dir, "payload.mjs");
      await writeFile(
        payload,
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "x");
`,
      );
      const ids = [`${posix(relative(root, payload))}#x`, `@fs/${posix(payload)}#x`];
      const responses = await Promise.all(
        ids.map((id) => fetch(`${origin}/_rinka/fn/${encodeURIComponent(id)}`)),
      );
      expect(responses.map((response) => response.status)).toEqual([404, 404]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("client の環境で変換したモジュールのサーバー関数を、RPC で呼び出せる", async () => {
    await server.environments.client.transformRequest("/src/lib/fns.ts");
    const response = await fetch(
      `${origin}/_rinka/fn/${encodeURIComponent("src/lib/fns.ts#ping")}`,
      {
        method: "POST",
      },
    );
    expect(await response.json()).toEqual({ ok: "pong" });
  });

  it("form の action に渡したサーバー関数に、JS が無いときと同じ multipart の送信をすると、Referer に 303 でリダイレクトする", async () => {
    const html = await (await fetch(`${origin}/fns`)).text();
    const action = `/_rinka/fn/${encodeURIComponent("src/lib/fns.ts#save")}`;
    expect(html).toContain(`<form action="${action}" method="post" enctype="multipart/form-data">`);
    const body = new FormData();
    body.append("title", "a");
    const response = await fetch(`${origin}${action}`, {
      method: "POST",
      body,
      headers: { referer: `${origin}/fns` },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/fns`);
  });

  it("ページの要素の中から、props で受け取ったサーバー関数と import したサーバー関数を RPC で呼び出せる", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${origin}/fns`);
      await page.locator("app-pinger[data-started]").waitFor();
      // 前のテストの /boom のエラーが、Vite のエラーのオーバーレイとしてボタンの上に表示されるので、click のイベントを直接送る
      await page.locator("app-pinger button").dispatchEvent("click");
      await page.locator("app-pinger button", { hasText: "pong pong" }).waitFor({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("Vite が処理するリクエストは、Vite が返す", async () => {
    const response = await fetch(`${origin}/src/elements/counter.tsx`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('__rinka_defineElement("app-counter"');
  });
});

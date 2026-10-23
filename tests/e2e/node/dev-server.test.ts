import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDevServer, originOf } from "../dev-server.ts";

const root = fileURLToPath(new URL("../fixtures/basic", import.meta.url));

/** パスの区切りを `/` にする。 */
const posix = (path: string) => path.split(sep).join("/");

let server: ViteDevServer;
let origin: string;

beforeAll(async () => {
  // e2e のプロジェクトの開発サーバーと依存の事前バンドルを共有しないように、キャッシュのディレクトリを分ける
  server = await createDevServer(root, {
    server: { port: 0 },
    cacheDir: fileURLToPath(new URL("../node_modules/.vite/node-dev-server", import.meta.url)),
  });
  await server.listen();
  origin = originOf(server);
});

afterAll(async () => {
  await server.close();
});

/** `name` のサーバー関数を 1 つだけ定義するモジュールのソースを返す。 */
const removedSource = (name: string) =>
  `import { defineServerFn } from "rinka/server";\nexport const ${name} = defineServerFn(() => "${name}");\n`;

/** 開発サーバーの、`src/lib/removed.ts` の `name` のサーバー関数を RPC で呼び出す。 */
const callRemoved = (name: string) =>
  fetch(`${origin}/_rinka/fn/${encodeURIComponent(`src/lib/removed.ts#${name}`)}`, {
    method: "POST",
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

  it("ページの描画で投げたエラーは、Vite のエラーのオーバーレイでメッセージを表示する 500 のページにする", async () => {
    const response = await fetch(`${origin}/boom`);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("ページの描画に失敗しました");
    expect(body).toContain('import { ErrorOverlay } from "/@vite/client";');
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

  it("まだ変換していないモジュールのサーバー関数を、RPC で呼び出せる", async () => {
    const response = await fetch(
      `${origin}/_rinka/fn/${encodeURIComponent("src/lib/late.ts#echo")}`,
      {
        method: "POST",
      },
    );
    expect(await response.json()).toEqual({ ok: "late" });
  });

  it("ファイルから削除したサーバー関数の ID は、サーバーのランナーがモジュールを評価し直さなくても、ファイルを変更した後に 404 になる", async () => {
    const file = join(root, "src/lib/removed.ts");
    try {
      await writeFile(file, removedSource("gone"));
      expect((await callRemoved("gone")).status).toBe(200);
      await writeFile(file, removedSource("kept"));
      server.watcher.emit("change", posix(file));
      // Vite は変更の通知を非同期に処理するので、変換の結果が変わるまで待つ
      await vi.waitUntil(async () => (await callRemoved("gone")).status === 404, { timeout: 2000 });
    } finally {
      await rm(file, { force: true });
    }
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
      await page.locator("app-pinger[data-started]").waitFor({ timeout: 5000 });
      // 前のテストの /boom のエラーが、Vite のエラーのオーバーレイとしてボタンの上に表示されるので、click のイベントを直接送る
      await page.locator("app-pinger button").dispatchEvent("click");
      await page.locator("app-pinger button", { hasText: "pong pong" }).waitFor({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("要素から refreshPage() を呼び出すと、要素の状態を保ったまま、本文と <title> と要素の props を描き直しで更新する", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${origin}/refresh`);
      await page.locator("app-refresher[data-started]").waitFor({ timeout: 5000 });
      const before = Number(await page.locator("#renders").textContent());
      await page.locator("app-refresher #count").dispatchEvent("click");
      await page
        .locator("app-refresher #count", { hasText: `v${before} 1` })
        .waitFor({ timeout: 5000 });
      await page.locator("app-refresher #refresh").dispatchEvent("click");
      const after = before + 1;
      await page.locator("#renders", { hasText: String(after) }).waitFor({ timeout: 5000 });
      await page
        .locator("app-refresher #count", { hasText: `v${after} 1` })
        .waitFor({ timeout: 5000 });
      expect(await page.title()).toBe(`refresh ${after}`);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("refreshPage() のレスポンスがリダイレクトのときは、ページを読み込み直してリダイレクト先に移動する", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${origin}/refresh-moved`);
      await page.locator("app-refresher[data-started]").waitFor({ timeout: 5000 });
      await page.locator("app-refresher #refresh").dispatchEvent("click");
      await page.waitForURL(`${origin}/refresh`, { timeout: 5000 });
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("JS があるときのフォームの送信は、要素の状態を保ったまま本文を描き直し、失敗したら URL を変えずに error.tsx を表示する", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${origin}/notes`);
      await page.locator("app-refresher[data-started]").waitFor({ timeout: 5000 });
      const before = await page.locator("#notes li").count();
      await page.locator("app-refresher #count").dispatchEvent("click");
      await page.locator("input[name=title]").fill("draft");
      await page.locator("#add").dispatchEvent("click");
      await page.locator("#notes li").nth(before).waitFor({ timeout: 5000 });
      await page.locator("app-refresher #count", { hasText: "notes 1" }).waitFor({ timeout: 5000 });
      expect(await page.locator("input[name=title]").inputValue()).toBe("");
      expect(page.url()).toBe(`${origin}/notes`);
      await page.locator("#fail").dispatchEvent("click");
      await page.locator("#error", { hasText: "note failed" }).waitFor({ timeout: 5000 });
      expect(page.url()).toBe(`${origin}/notes`);
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

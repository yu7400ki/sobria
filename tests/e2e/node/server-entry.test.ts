import { fileURLToPath } from "node:url";

import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDevServer, originOf } from "../dev-server.ts";

/** src/server.ts を持つテスト用のアプリのルートである。 */
const root = fileURLToPath(new URL("../fixtures/deploy", import.meta.url));

let server: ViteDevServer;
let origin: string;

beforeAll(async () => {
  server = await createDevServer(root, {
    server: { port: 0 },
    cacheDir: fileURLToPath(new URL("../node_modules/.vite/server-entry", import.meta.url)),
  });
  await server.listen();
  origin = originOf(server);
});

afterAll(async () => {
  await server?.close();
});

describe("開発サーバーのサーバーのエントリー", () => {
  it("src/server.ts に追加したルートに応答し、rinka のページと 404 は src/server.ts を通して返す", async () => {
    expect(await (await fetch(`${origin}/health`)).text()).toBe("ok");
    const html = await (await fetch(`${origin}/`)).text();
    expect(html).toContain('<script type="module" src="/@vite/client"></script>');
    expect(html).toContain("<h1>deploy</h1>");
    expect(html).toMatch(/<link rel="stylesheet" href="\/src\/styles\/app\.css[^"]*">/);
    expect((await fetch(`${origin}/missing`)).status).toBe(404);
    expect((await fetch(`${origin}/`)).headers.get("x-server-entry")).toBe("1");
  });

  it("開発サーバーを再起動しても、サーバーコンポーネントの CSS の <link> を出力する", async () => {
    await server.restart();
    origin = originOf(server);
    const html = await (await fetch(`${origin}/`)).text();
    expect(html).toMatch(/<link rel="stylesheet" href="\/src\/styles\/app\.css[^"]*">/);
  });

  it("サーバー関数の RPC は、ファイルのパスの ID で呼び出せる", async () => {
    const id = encodeURIComponent("src/lib/orphan.ts#orphan");
    const response = await fetch(`${origin}/_rinka/fn/${id}`, { method: "POST" });
    expect(await response.json()).toEqual({ ok: "orphan" });
  });
});

/** 開発中の rinka/app が使用する関数を保持する、グローバルの Map の大きさを返す。 */
const hookCount = () =>
  (globalThis as { [key: symbol]: Map<string, unknown> | undefined })[Symbol.for("rinka.dev")]
    ?.size ?? 0;

/** テスト用のアプリの開発サーバーを作成し、再起動してからページがサーバーコンポーネントの CSS の <link> を出力することを確認して、閉じる。 */
async function startAndClose(): Promise<void> {
  const dev = await createDevServer(root, {
    server: { port: 0 },
    cacheDir: fileURLToPath(new URL("../node_modules/.vite/server-entry", import.meta.url)),
  });
  await dev.listen();
  await dev.restart();
  const html = await (await fetch(`${originOf(dev)}/`)).text();
  expect(html).toMatch(/<link rel="stylesheet" href="\/src\/styles\/app\.css[^"]*">/);
  await dev.close();
}

describe("開発サーバーの終了", () => {
  it("開発サーバーを閉じると、再起動した後でも、開発中の rinka/app が使用する関数を削除する", async () => {
    const before = hookCount();
    await startAndClose();
    expect(hookCount()).toBe(before);
    await startAndClose();
    expect(hookCount()).toBe(before);
  }, 60_000);
});

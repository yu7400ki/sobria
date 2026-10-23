import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDevServer, originOf } from "../dev-server.ts";
import { buildFixture, rpcPath, startServer } from "./production.ts";

/** wrangler の CLI のスクリプトである。 */
const wranglerBin = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

/** Worker の `main` を `rinka/app` にした Cloudflare のプラグインを返す。 */
const workers = () =>
  cloudflare({
    viteEnvironment: { name: "ssr" },
    config: {
      name: "rinka-deploy",
      main: "rinka/app",
      compatibility_date: "2026-07-01",
      compatibility_flags: ["nodejs_als"],
    },
  });

let copy: string;

beforeAll(async () => {
  // rinka を解決できるように、コピーは tests/e2e の中に置く
  copy = await mkdtemp(fileURLToPath(new URL("../.rinka-tmp-", import.meta.url)));
  await cp(fileURLToPath(new URL("../fixtures/deploy", import.meta.url)), copy, {
    recursive: true,
  });
  await rm(join(copy, "src/server.ts"));
});

afterAll(async () => {
  await rm(copy, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("@cloudflare/vite-plugin との組み合わせ", () => {
  let dev: ViteDevServer;

  afterAll(async () => {
    await dev?.close();
  });

  it("開発中は、workerd の Worker が rinka/app でページ、要素のモジュール、RPC に応答する", async () => {
    dev = await createDevServer(copy, {
      server: { port: 0 },
      cacheDir: join(copy, "node_modules/.vite"),
      plugins: [workers()],
    });
    await dev.listen();
    const origin = originOf(dev);
    const html = await (await fetch(`${origin}/`)).text();
    expect(html).toContain('<script type="module" src="/@vite/client"></script>');
    expect(html).toContain("<h1>deploy</h1>");
    expect((await fetch(`${origin}/src/elements/counter.tsx`)).status).toBe(200);
    const id = encodeURIComponent("src/lib/orphan.ts#orphan");
    const rpc = await fetch(`${origin}/_rinka/fn/${id}`, { method: "POST" });
    expect(await rpc.json()).toEqual({ ok: "orphan" });
  }, 120_000);

  it("ビルドの出力を、Cloudflare のプラグインが出力した設定で、引数なしの wrangler dev が動作させる", async () => {
    await buildFixture(copy, join(copy, "dist"), {}, [workers()]);
    const server = await startServer(
      process.execPath,
      (port) => [wranglerBin, "dev", "--ip", "127.0.0.1", "--port", String(port)],
      copy,
    );
    try {
      const origin = server.origin.replace("localhost", "127.0.0.1");
      const html = await (await fetch(`${origin}/`)).text();
      expect(html).toContain("<h1>deploy</h1>");
      expect((await fetch(`${origin}/missing`)).status).toBe(404);
      const module = /\$rinka\.m\(\[\["app-counter","([^"]+)"/.exec(html)![1]!;
      expect((await fetch(`${origin}${module}`)).status).toBe(200);
      expect((await fetch(`${origin}/.vite/manifest.json`)).status).toBe(404);
      const rpc = await fetch(`${origin}${rpcPath("src/lib/orphan.ts", "orphan")}`, {
        method: "POST",
      });
      expect(await rpc.json()).toEqual({ ok: "orphan" });
      const form = (title: string) => {
        const body = new FormData();
        body.append("title", title);
        return fetch(`${origin}${rpcPath("src/lib/fns.ts", "save")}`, {
          method: "POST",
          body,
          headers: { referer: `${origin}/` },
          redirect: "manual",
        });
      };
      expect((await form("a")).status).toBe(303);
      expect((await form("")).status).toBe(422);
    } finally {
      await server.stop();
    }
  }, 180_000);
});

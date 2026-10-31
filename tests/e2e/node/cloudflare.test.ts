import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDevServer, originOf } from "../dev-server.ts";
import { buildFixture, fnId, rpcPath, startServer } from "./production.ts";

/** wrangler の CLI のスクリプトである。 */
const wranglerBin = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

/** Worker の `main` を `sobria/app` にした Cloudflare のプラグインを返す。 */
const workers = () =>
  cloudflare({
    viteEnvironment: { name: "ssr" },
    config: {
      name: "sobria-deploy",
      main: "sobria/app",
      compatibility_date: "2026-07-01",
      compatibility_flags: ["nodejs_als"],
    },
  });

/** Worker の `main` を `./src/server.ts` にし、`run_worker_first` で `/assets/` の外のリクエストを静的アセットより先に Worker に渡す設定の、Cloudflare のプラグインを返す。 */
const workerFirst = () =>
  cloudflare({
    viteEnvironment: { name: "ssr" },
    config: {
      name: "sobria-deploy",
      main: "./src/server.ts",
      compatibility_date: "2026-07-01",
      compatibility_flags: ["nodejs_als"],
      assets: {
        binding: "ASSETS",
        html_handling: "drop-trailing-slash",
        run_worker_first: ["/*", "!/assets/*"],
      },
    },
  });

let copy: string;

beforeAll(async () => {
  // sobria を解決できるように、コピーは tests/e2e の中に置く
  copy = await mkdtemp(fileURLToPath(new URL("../.sobria-tmp-", import.meta.url)));
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

  it("開発中は、workerd の Worker が sobria/app で、サーバーコンポーネントの CSS を含むページ、エラーのページ、要素のモジュール、RPC に応答する", async () => {
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
    expect(html).toMatch(/<link rel="stylesheet" href="\/src\/styles\/app\.css[^"]*">/);
    expect((await fetch(`${origin}/src/elements/counter.tsx`)).status).toBe(200);
    const boom = await fetch(`${origin}/boom`);
    expect(boom.status).toBe(500);
    const error = await boom.text();
    expect(error).toContain("ページの描画に失敗しました");
    expect(error).toContain("ErrorOverlay");
    const id = encodeURIComponent("src/lib/orphan.ts#orphan");
    const rpc = await fetch(`${origin}/_sobria/fn/${id}`, { method: "POST" });
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
      const module = /\$sobria\.m\(\[\["app-counter","([^"]+)"/.exec(html)![1]!;
      expect((await fetch(`${origin}${module}`)).status).toBe(200);
      expect((await fetch(`${origin}/.vite/manifest.json`)).status).toBe(404);
      const rpc = await fetch(`${origin}${rpcPath("src/lib/orphan.ts", "orphan")}`, {
        method: "POST",
      });
      expect(await rpc.json()).toEqual({ ok: "orphan" });
      const form = (title: string) => {
        const body = new FormData();
        body.append("_sobria_fn", fnId("src/lib/fns.ts", "save"));
        body.append("title", title);
        return fetch(`${origin}/`, { method: "POST", body, redirect: "manual" });
      };
      expect((await form("a")).status).toBe(200);
      expect((await form("")).status).toBe(422);
    } finally {
      await server.stop();
    }
  }, 180_000);
});

describe("run_worker_first で、書き出したページへの送信を Worker に渡す構成", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(fileURLToPath(new URL("../.sobria-tmp-", import.meta.url)));
    await cp(fileURLToPath(new URL("../fixtures/deploy", import.meta.url)), root, {
      recursive: true,
    });
    await mkdir(join(root, "src/routes/contact"));
    await writeFile(
      join(root, "src/routes/contact/page.tsx"),
      [
        'import type { Prerender } from "sobria/router";',
        'import { save } from "../../lib/fns.ts";',
        "",
        'export const prerender: Prerender<"/contact"> = true;',
        "",
        "export default function Contact() {",
        "  return (",
        "    <form action={save}>",
        '      <input name="title" />',
        "    </form>",
        "  );",
        "}",
        "",
      ].join("\n"),
    );
    // 次のエントリーは、packages/docs の deploy.mdx に記述したエントリーと同じ内容である
    await writeFile(
      join(root, "src/server.ts"),
      [
        'import type { ExecutionContext } from "hono";',
        'import app from "sobria/app";',
        "",
        "interface Env {",
        "  readonly ASSETS?: { fetch(request: Request): Promise<Response> };",
        "}",
        "",
        "export default {",
        "  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {",
        '    if (env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {',
        "      const asset = await env.ASSETS.fetch(request);",
        "      if (asset.status !== 404) return asset;",
        "    }",
        "    return app.fetch(request, env, ctx);",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("開発中も、ページ、要素のモジュール、フォームの送信が動作する", async () => {
    const dev = await createDevServer(root, {
      server: { port: 0 },
      cacheDir: join(root, "node_modules/.vite"),
      plugins: [workerFirst()],
    });
    try {
      await dev.listen();
      const origin = originOf(dev);
      expect(await (await fetch(`${origin}/contact`)).text()).toContain('name="_sobria_fn"');
      expect((await fetch(`${origin}/src/elements/counter.tsx`)).status).toBe(200);
      const body = new FormData();
      body.append("_sobria_fn", "src/lib/fns.ts#save");
      body.append("title", "");
      const submitted = await fetch(`${origin}/contact`, { method: "POST", body });
      expect(submitted.status).toBe(422);
    } finally {
      await dev.close();
    }
  }, 120_000);

  it("書き出したページの GET には書き出したファイルを返し、POST はフォームの送信として処理する", async () => {
    await buildFixture(root, join(root, "dist"), {}, [workerFirst()]);
    const server = await startServer(
      process.execPath,
      (port) => [wranglerBin, "dev", "--ip", "127.0.0.1", "--port", String(port)],
      root,
    );
    try {
      const origin = server.origin.replace("localhost", "127.0.0.1");
      // sobria が描画したレスポンスは Vary ヘッダーに x-sobria-refresh を持ち、書き出したファイルは Vary ヘッダーを持たない
      const contact = await fetch(`${origin}/contact`);
      expect(contact.status).toBe(200);
      expect(contact.headers.get("vary")).toBeNull();
      expect(await contact.text()).toContain('name="_sobria_fn"');
      const slash = await fetch(`${origin}/contact/`, { redirect: "manual" });
      expect(slash.status).toBe(307);
      expect(slash.headers.get("location")).toBe("/contact");
      const top = await fetch(`${origin}/`);
      expect(top.headers.get("vary")).toContain("x-sobria-refresh");
      const module = /\$sobria\.m\(\[\["app-counter","([^"]+)"/.exec(await top.text())![1]!;
      expect((await fetch(`${origin}${module}`)).status).toBe(200);
      expect((await fetch(`${origin}/missing`)).status).toBe(404);
      const form = (title: string) => {
        const body = new FormData();
        body.append("_sobria_fn", fnId("src/lib/fns.ts", "save"));
        body.append("title", title);
        return fetch(`${origin}/contact`, { method: "POST", body, redirect: "manual" });
      };
      expect((await form("a")).status).toBe(200);
      expect((await form("")).status).toBe(422);
    } finally {
      await server.stop();
    }
  }, 180_000);
});

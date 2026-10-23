import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rinka } from "rinka/vite";
import { createBuilder, preview } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** ビルドするテスト用のアプリのルートである。 */
const root = fileURLToPath(new URL("../fixtures/deploy", import.meta.url));

/** 本番のビルドでの、ファイル `file` のサーバー関数 `name` の RPC のパスを返す。 */
const rpcPath = (file: string, name: string) => {
  const module = `m${createHash("sha256").update(file).digest("base64url").slice(0, 10)}`;
  return `/_rinka/fn/${encodeURIComponent(`${module}#${name}`)}`;
};

let outDir: string;
let app: { fetch(request: Request): Response | Promise<Response> };

/** `dir` の中のすべてのファイルの内容を連結して返す。 */
async function contents(dir: string): Promise<string> {
  const files = await readdir(dir, { recursive: true, withFileTypes: true });
  const texts = await Promise.all(
    files
      .filter((entry) => entry.isFile() && /\.(js|css|json)$/.test(entry.name))
      .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
  );
  return texts.join("\n");
}

/** ビルドしたアプリの `save` のサーバー関数に、`title` を入力したフォームを JS が無いときの形で送る。 */
function send(title: string) {
  const body = new FormData();
  body.append("title", title);
  return request(rpcPath("src/lib/fns.ts", "save"), {
    method: "POST",
    body,
    headers: { referer: "http://localhost/" },
    redirect: "manual",
  });
}

/** ビルドしたアプリに、パス `path` のリクエストを送る。 */
const request = (path: string, init?: RequestInit) =>
  app.fetch(new Request(new URL(path, "http://localhost"), init));

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "rinka-build-"));
  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: "error",
    plugins: [rinka({ prefix: "app", outDir })],
  });
  await builder.buildApp();
  ({ app } = (await import(pathToFileURL(join(outDir, "server/entry.js")).href)) as {
    app: typeof app;
  });
}, 120_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe("本番のビルド", () => {
  it("dist/server/entry.js の app は、ページと API ルートに応答し、無いページには 404 を返す", async () => {
    const page = await request("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>deploy</h1>");
    expect((await request("/missing")).status).toBe(404);
    expect(await (await request("/api")).json()).toEqual({ ok: true });
  });

  it("ページの要素のモジュールの URL と先読みは、クライアントのビルドが出力した /assets/ のファイルを指す", async () => {
    const html = await (await request("/")).text();
    const module = /\$rinka\.m\(\[\["app-counter","([^"]+)"/.exec(html)?.[1];
    expect(module).toMatch(/^\/assets\/.+\.js$/);
    const preloads = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(
      ([, href]) => href!,
    );
    expect(preloads).toContain(module);
    // 2 つの要素が共有する rinka のランタイムは、要素のモジュールが静的に import するチャンクになる
    expect(preloads.length).toBeGreaterThan(2);
    await Promise.all(preloads.map((url) => readFile(join(outDir, "client", url))));
  });

  it("レイアウトが import した CSS と、要素のシートの DSD の <link> は、クライアントの出力の /assets/ の CSS を指す", async () => {
    const html = await (await request("/")).text();
    const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(
      ([, href]) => href!,
    );
    expect(links.length).toBeGreaterThanOrEqual(2);
    const texts = await Promise.all(
      links.map((href) => {
        expect(href).toMatch(/^\/assets\/.+\.css$/);
        return readFile(join(outDir, "client", href), "utf8");
      }),
    );
    expect(texts.join("\n")).toContain("h1{color:#00f}");
    expect(texts.join("\n")).toContain(".count{color:red}");
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toMatch(/<link rel="stylesheet" href="\/assets\/[^"]+\.css">/);
  });

  it("サーバーの出力の CSS はクライアントの出力に移動し、ソースマップと JSON は移動しない", async () => {
    const server = await readdir(join(outDir, "server"), { recursive: true });
    expect(server.filter((file) => file.endsWith(".css"))).toEqual([]);
    const client = await readdir(join(outDir, "client"), { recursive: true });
    expect(client.filter((file) => file.endsWith(".map"))).toEqual([]);
  });

  it("どのページからも import されていないサーバー関数も、ハッシュの ID の RPC で呼び出せる", async () => {
    const response = await request(rpcPath("src/lib/orphan.ts", "orphan"), { method: "POST" });
    expect(await response.json()).toEqual({ ok: "orphan" });
  });

  it("フォームの送信は、スキーマを通過すると Referer に 303 を返し、失敗すると 422 の issues を返す", async () => {
    const accepted = await send("a");
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe("http://localhost/");
    const rejected = await send("");
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ issues: [{ path: ["title"] }] });
  });

  it("サーバーの出力はアプリのソースを import せず、クライアントの出力にサーバー関数の定義と Hono が含まれない", async () => {
    const server = await contents(join(outDir, "server"));
    expect(server).not.toMatch(/import\(\s*["']\/src\//);
    const client = await contents(join(outDir, "client"));
    expect(client).not.toContain("registerServerFn");
    expect(client).not.toContain("orphan");
    expect(client).not.toContain("HTTPException");
  });
});

/** 使用されていないポートの番号を返す。 */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** オリジン `origin` のサーバーが応答するまで、100ms ごとに最大 `attempts` 回試す。 */
async function waitFor(origin: string, attempts = 100): Promise<void> {
  try {
    await fetch(origin);
  } catch {
    if (attempts === 0) throw new Error(`${origin} が応答しません。`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await waitFor(origin, attempts - 1);
  }
}

/** オリジン `origin` で動作するビルドしたサーバーに、ページ、アセット、配信しないパス、RPC、フォームの送信のリクエストを送り、結果を確認する。 */
async function checkServer(origin: string): Promise<void> {
  const html = await (await fetch(`${origin}/`)).text();
  expect(html).toContain("<h1>deploy</h1>");
  const module = /\$rinka\.m\(\[\["app-counter","([^"]+)"/.exec(html)![1]!;
  const asset = await fetch(`${origin}${module}`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get("content-type")).toMatch(/javascript/);
  expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect((await fetch(`${origin}/.vite/manifest.json`)).status).toBe(404);
  expect((await fetch(`${origin}/%2e%2e/%2e%2e/package.json`)).status).toBe(404);
  const rpc = await fetch(`${origin}${rpcPath("src/lib/orphan.ts", "orphan")}`, { method: "POST" });
  expect(await rpc.json()).toEqual({ ok: "orphan" });
  const body = new FormData();
  body.append("title", "a");
  const form = await fetch(`${origin}${rpcPath("src/lib/fns.ts", "save")}`, {
    method: "POST",
    body,
    headers: { referer: `${origin}/` },
    redirect: "manual",
  });
  expect(form.status).toBe(303);
}

/** `dist` を node_modules の無い一時ディレクトリにコピーし、`command` で `index.js` を起動して確認する。 */
async function checkRuntime(command: string): Promise<void> {
  const copy = await mkdtemp(join(tmpdir(), "rinka-dist-"));
  await cp(outDir, copy, { recursive: true });
  const port = await freePort();
  const child = spawn(command, [join(copy, "server/index.js")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  try {
    await waitFor(`http://localhost:${port}`);
    await checkServer(`http://localhost:${port}`);
  } finally {
    child.kill();
    await rm(copy, { recursive: true, force: true });
  }
}

/** bun を実行できるかどうかである。 */
const hasBun = spawnSync("bun", ["--version"]).status === 0;

describe("起動用のエントリー", () => {
  it("node で起動した index.js は、dist/client を配信し、それ以外のリクエストをアプリに渡す", async () => {
    await checkRuntime(process.execPath);
  }, 60_000);

  it("Node の API を使用するのは index.js だけで、entry.js とそのチャンクは使用しない", async () => {
    const files = await readdir(join(outDir, "server"), { recursive: true });
    const used = await Promise.all(
      files
        .filter((file) => file.endsWith(".js") && file !== "index.js")
        .map(async (file) =>
          /from "node:(?!async_hooks)/.test(await readFile(join(outDir, "server", file), "utf8")),
        ),
    );
    expect(used).not.toContain(true);
    expect(await readFile(join(outDir, "server/index.js"), "utf8")).toContain("node:fs");
  });

  it.skipIf(!hasBun)(
    "deploy: 'bun' でビルドした index.js を bun で起動しても、同じように動作する",
    async () => {
      const bunOut = await mkdtemp(join(tmpdir(), "rinka-build-bun-"));
      try {
        const builder = await createBuilder({
          root,
          configFile: false,
          logLevel: "error",
          plugins: [rinka({ prefix: "app", outDir: bunOut, deploy: "bun" })],
        });
        await builder.buildApp();
        expect(await readFile(join(bunOut, "server/index.js"), "utf8")).toContain("Bun.serve");
        const saved = outDir;
        outDir = bunOut;
        try {
          await checkRuntime("bun");
        } finally {
          outDir = saved;
        }
      } finally {
        await rm(bunOut, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it("vite preview は、dist/client を配信し、それ以外のリクエストをビルドしたアプリに渡す", async () => {
    const server = await preview({
      root,
      configFile: false,
      logLevel: "error",
      plugins: [rinka({ prefix: "app", outDir })],
      preview: { port: await freePort() },
    });
    try {
      const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
      const html = await (await fetch(`${origin}/`)).text();
      expect(html).toContain("<h1>deploy</h1>");
      const module = /\$rinka\.m\(\[\["app-counter","([^"]+)"/.exec(html)![1]!;
      expect((await fetch(`${origin}${module}`)).status).toBe(200);
      const rpc = await fetch(`${origin}${rpcPath("src/lib/orphan.ts", "orphan")}`, {
        method: "POST",
      });
      expect(await rpc.json()).toEqual({ ok: "orphan" });
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe("要素の無いアプリ", () => {
  it("要素が 1 つも無いアプリもビルドでき、ページに応答する", async () => {
    const out = await mkdtemp(join(tmpdir(), "rinka-build-empty-"));
    try {
      const builder = await createBuilder({
        root: fileURLToPath(new URL("../fixtures/no-elements", import.meta.url)),
        configFile: false,
        logLevel: "error",
        plugins: [rinka({ prefix: "app", outDir: out })],
      });
      await builder.buildApp();
      const { app: empty } = (await import(pathToFileURL(join(out, "server/entry.js")).href)) as {
        app: typeof app;
      };
      const html = await (await empty.fetch(new Request("http://localhost/"))).text();
      expect(html).toContain("<h1>no elements</h1>");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});

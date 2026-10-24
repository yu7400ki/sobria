import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rinka } from "rinka/vite";
import { preview, type InlineConfig } from "vite";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { buildFixture, rpcPath, startServer } from "./production.ts";

/** ビルドするテスト用のアプリのルートである。 */
const root = fileURLToPath(new URL("../fixtures/deploy", import.meta.url));

/** ビルドしたサーバーのエントリーの default export を表す。 */
type App = { fetch(request: Request): Response | Promise<Response> };

let outDir: string;
let app: App;

/** ビルドの出力先 `out` の `dist/server/entry.js` の default export を返す。 */
async function serverEntry(out: string): Promise<App> {
  const module = (await import(pathToFileURL(join(out, "server/entry.js")).href)) as {
    default: App;
  };
  return module.default;
}

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

/** HTML `html` の `<link rel="stylesheet">` の URL を、出現する順に返す。 */
const stylesheets = (html: string) =>
  [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(([, href]) => href!);

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
  await buildFixture(root, outDir);
  app = await serverEntry(outDir);
}, 120_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe("本番のビルド", () => {
  it("dist/server/entry.js は src/server.ts をビルドしたもので、src/server.ts のルートと、rinka のページと API ルートに応答し、無いページには 404 を返す", async () => {
    expect(await (await request("/health")).text()).toBe("ok");
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
    const links = stylesheets(html);
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

  it("要素のシートの DSD の <link> は、クライアントの要素のモジュールが取得する CSS と同じ URL を指す", async () => {
    const html = await (await request("/")).text();
    const counter = html.slice(html.indexOf("<app-counter"), html.indexOf("</app-counter>"));
    const sheet = /<link rel="stylesheet" href="([^"]+)">/.exec(counter)?.[1];
    expect(sheet).toMatch(/^\/assets\/.+\.css$/);
    const module = /\$rinka\.m\(\[\["app-counter","([^"]+)"/.exec(html)![1]!;
    expect(await readFile(join(outDir, "client", module), "utf8")).toContain(sheet);
  });

  it("サーバーの出力の CSS はクライアントの出力に移動し、ソースマップと JSON と Vite の manifest はクライアントの出力に残らない", async () => {
    const server = await readdir(join(outDir, "server"), { recursive: true });
    expect(server.filter((file) => file.endsWith(".css"))).toEqual([]);
    const client = await readdir(join(outDir, "client"), { recursive: true });
    expect(client.filter((file) => /\.(map|json)$/.test(file))).toEqual([]);
    expect(client.filter((file) => file.startsWith(".vite"))).toEqual([]);
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

/** オリジン `origin` で動作するビルドしたサーバーに、ページ、アセット、配信しないパス、RPC、フォームの送信のリクエストを送り、結果を確認する。 */
async function checkServer(origin: string): Promise<void> {
  expect(await (await fetch(`${origin}/health`)).text()).toBe("ok");
  const html = await (await fetch(`${origin}/`)).text();
  expect(html).toContain("<h1>deploy</h1>");
  expect((await fetch(`${origin}/missing`)).status).toBe(404);
  const module = /\$rinka\.m\(\[\["app-counter","([^"]+)"/.exec(html)![1]!;
  const asset = await fetch(`${origin}${module}`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get("content-type")).toMatch(/javascript/);
  expect((await fetch(`${origin}/.vite/manifest.json`)).status).toBe(404);
  expect((await fetch(`${origin}/..%2f..%2fpackage.json`)).status).toBe(404);
  const rpc = await fetch(`${origin}${rpcPath("src/lib/orphan.ts", "orphan")}`, { method: "POST" });
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
}

/** ビルドの出力先 `out` を node_modules の無い一時ディレクトリにコピーし、`command` で `entry.js` を実行して確認する。 */
async function checkRuntime(command: string, out: string): Promise<void> {
  const copy = await mkdtemp(join(tmpdir(), "rinka-dist-"));
  await cp(out, copy, { recursive: true });
  try {
    const server = await startServer(command, () => [join(copy, "server/entry.js")]);
    try {
      await checkServer(server.origin);
    } finally {
      await server.stop();
    }
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

/** bun を実行できるかどうかである。 */
const hasBun = spawnSync("bun", ["--version"]).status === 0;

/** Bun で起動するときの、`serve()` を呼び出さないサーバーのエントリーである。 */
const BUN_SERVER = `import { fileURLToPath } from "node:url";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import app from "rinka/app";

const server = new Hono();
if (import.meta.main) {
  server.use(serveStatic({ root: fileURLToPath(new URL("../client", import.meta.url)) }));
}
server.get("/health", (c) => c.text("ok"));
server.route("/", app);

export default server;
`;

describe("サーバーの起動", () => {
  it("node で実行した dist/server/entry.js は、src/server.ts のとおりに dist/client を配信し、それ以外のリクエストをアプリに渡す", async () => {
    await checkRuntime(process.execPath, outDir);
  }, 60_000);

  it.skipIf(!hasBun)(
    "serve() を呼び出さない src/server.ts でビルドした dist/server/entry.js を bun で実行すると、Bun が default export でサーバーを起動する",
    async () => {
      // rinka を解決できるように、コピーは tests/e2e の中に置く
      const copy = await mkdtemp(fileURLToPath(new URL("../.rinka-tmp-", import.meta.url)));
      try {
        await cp(root, copy, { recursive: true });
        await writeFile(join(copy, "src/server.ts"), BUN_SERVER);
        await buildFixture(copy, join(copy, "dist"));
        await checkRuntime("bun", join(copy, "dist"));
      } finally {
        await rm(copy, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it("vite preview は、dist/client を配信し、それ以外のリクエストをビルドしたサーバーのエントリーに渡す", async () => {
    const server = await preview({
      root,
      configFile: false,
      logLevel: "error",
      plugins: [rinka({ prefix: "app", outDir })],
      preview: { port: 0 },
    });
    try {
      await checkServer(server.resolvedUrls!.local[0]!.replace(/\/$/, ""));
    } finally {
      await server.close();
    }
  }, 60_000);

  it("vite preview は、サーバーのエントリーの fetch が投げたエラーに、本文の無い 500 を返す", async () => {
    const out = await mkdtemp(join(tmpdir(), "rinka-preview-error-"));
    await cp(join(outDir, "client"), join(out, "client"), { recursive: true });
    await cp(join(outDir, "server"), join(out, "server"), { recursive: true });
    await writeFile(
      join(out, "server/entry.js"),
      'export default { fetch() { throw new Error("boom-secret"); } };\n',
    );
    const server = await preview({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [rinka({ prefix: "app", outDir: out })],
      preview: { port: 0 },
    });
    try {
      const response = await fetch(`${server.resolvedUrls!.local[0]!.replace(/\/$/, "")}/`);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("");
    } finally {
      await server.close();
      await rm(out, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 60_000);
});

describe("src/server.ts の無いアプリ", () => {
  it("rinka/app をサーバーのエントリーにし、要素が 1 つも無くてもビルドでき、出力は node:async_hooks 以外の Node の API を import しない", async () => {
    const out = await mkdtemp(join(tmpdir(), "rinka-build-empty-"));
    try {
      await buildFixture(fileURLToPath(new URL("../fixtures/no-elements", import.meta.url)), out);
      const empty = await serverEntry(out);
      const html = await (await empty.fetch(new Request("http://localhost/"))).text();
      expect(html).toContain("<h1>no elements</h1>");
      const files = await readdir(join(out, "server"), { recursive: true });
      const used = await Promise.all(
        files
          .filter((file) => file.endsWith(".js"))
          .map(async (file) =>
            /from "node:(?!async_hooks)/.test(await readFile(join(out, "server", file), "utf8")),
          ),
      );
      expect(used).not.toContain(true);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});

/** レイアウトと要素が同じ CSS を読み込むテスト用のアプリを表す。 */
interface SharedSheetBuild {
  /** ビルドの出力先である。 */
  readonly out: string;
  /** `<head>` の `<link>` の URL である。 */
  readonly head: readonly string[];
  /** 要素の DSD の `<link>` の URL である。 */
  readonly dsd: readonly string[];
  /** 要素のモジュールが取得する CSS の URL である。 */
  readonly fetched: readonly string[];
}

/** shared-sheet のテスト用のアプリを Vite の設定 `config` で一時ディレクトリにビルドし、`/` のページが参照する CSS の URL を返す。一時ディレクトリはテストの終了後に削除する。 */
async function buildSharedSheet(config: InlineConfig): Promise<SharedSheetBuild> {
  const out = await mkdtemp(join(tmpdir(), "rinka-build-shared-sheet-"));
  onTestFinished(() => rm(out, { recursive: true, force: true }));
  await buildFixture(
    fileURLToPath(new URL("../fixtures/shared-sheet", import.meta.url)),
    out,
    {},
    [],
    config,
  );
  const html = await (
    await (await serverEntry(out)).fetch(new Request("http://localhost/"))
  ).text();
  const module = /\$rinka\.m\(\[\["app-note","([^"]+)"/.exec(html)![1]!;
  const code = await readFile(join(out, "client", module), "utf8");
  return {
    out,
    head: stylesheets(html.slice(0, html.indexOf("</head>"))),
    dsd: stylesheets(html.slice(html.indexOf("<app-note"), html.indexOf("</app-note>"))),
    fetched: [...code.matchAll(/["'`](\/[^"'`]+\.css)["'`]/g)].map(([, url]) => url!),
  };
}

describe("レイアウトと要素が同じ CSS を import するアプリ", () => {
  it.each([
    ["Vite のデフォルトの設定", {}],
    ["build.minify が false の設定", { build: { minify: false } }],
    [
      "クライアントの環境だけの build.assetsDir の設定",
      { environments: { client: { build: { assetsDir: "static" } } } },
    ],
    [
      "クライアントの環境だけの build.minify が false の設定",
      { environments: { client: { build: { minify: false } } } },
    ],
  ])(
    "%sでビルドすると、<head> の <link>、要素のシートの DSD の <link>、要素のモジュールは、同じ 1 つの CSS の URL を参照する",
    async (_name, config) => {
      const { out, head, dsd, fetched } = await buildSharedSheet(config);
      const urls = [...head, ...dsd, ...fetched];
      expect(urls).toHaveLength(3);
      expect(new Set(urls)).toEqual(new Set([urls[0]]));
      const css = await readFile(join(out, "client", urls[0]!), "utf8");
      const files = await readdir(join(out, "client"), { recursive: true });
      const same = await Promise.all(
        files
          .filter((file) => file.endsWith(".css"))
          .map(async (file) => (await readFile(join(out, "client", file), "utf8")) === css),
      );
      expect(same.filter(Boolean)).toHaveLength(1);
    },
    120_000,
  );

  it("サーバーの環境だけで CSS の処理を変更しても、要素のシートの DSD の <link> と要素のモジュールは、同じ URL を参照する", async () => {
    const { dsd, fetched } = await buildSharedSheet({
      environments: { ssr: { build: { cssTarget: "chrome100" } } },
    });
    expect(dsd).toHaveLength(1);
    expect(fetched).toEqual(dsd);
  }, 120_000);
});

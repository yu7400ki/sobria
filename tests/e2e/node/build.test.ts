import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rinka } from "rinka/vite";
import { createBuilder } from "vite";
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

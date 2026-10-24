import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rinka } from "rinka/vite";
import { createServer, preview } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { originOf } from "../dev-server.ts";
import { buildFixture } from "./production.ts";

/** ビルドするテスト用のアプリのルートである。 */
const root = fileURLToPath(new URL("../fixtures/prerender", import.meta.url));

/** ビルドしたサーバーのエントリーの default export を表す。 */
type App = { fetch(request: Request): Response | Promise<Response> };

const temporaries: string[] = [];

/** 一時ディレクトリを作成して返す。テストの後で削除する。 */
async function temporary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rinka-prerender-"));
  temporaries.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(temporaries.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("prerender を export するページと route.ts の書き出し", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = join(await temporary(), "dist");
    await buildFixture(root, outDir);
  }, 60_000);

  /** 書き出したファイル `path` の内容を返す。 */
  const written = (path: string) => readFile(join(outDir, "client", path), "utf8");

  it("ページを <パス>/index.html に、route.ts を URL のパスのとおりに書き出し、<Loading> の中身を待った HTML にする", async () => {
    expect(await written("index.html")).toContain("<h1>home</h1>");
    const about = await written("about/index.html");
    expect(about).toContain("<p>late</p>");
    expect(about).not.toContain("waiting");
    expect(await written("posts/hello/index.html")).toContain("<h1>post hello</h1>");
    expect(await written("posts/a b/index.html")).toContain("<h1>post a b</h1>");
    expect(await written("feed.xml")).toBe("<feed></feed>");
  });

  it("prerender の無いページは書き出さず、サーバーのエントリーが描画する。書き出しのモジュールは出力に残さない", async () => {
    expect(existsSync(join(outDir, "client/dynamic"))).toBe(false);
    expect(existsSync(join(outDir, "server/prerender.js"))).toBe(false);
    const module = (await import(pathToFileURL(join(outDir, "server/entry.js")).href)) as {
      default: App;
    };
    const response = await module.default.fetch(new Request("http://localhost/dynamic"));
    expect(await response.text()).toContain("<h1>dynamic</h1>");
  });

  it("vite preview は、書き出した HTML をサーバーのエントリーより先に返す", async () => {
    await appendFile(join(outDir, "client/about/index.html"), "<!-- written -->");
    const server = await preview({
      root,
      configFile: false,
      logLevel: "error",
      plugins: [rinka({ prefix: "app", outDir })],
      preview: { port: 0 },
    });
    try {
      const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
      expect(await (await fetch(`${origin}/about`)).text()).toContain("<!-- written -->");
      expect(await (await fetch(`${origin}/dynamic`)).text()).toContain("<h1>dynamic</h1>");
    } finally {
      await server.close();
    }
  }, 60_000);
});

/** テスト用のアプリを tests/e2e の中の一時ディレクトリにコピーし、そのルートを返す。 */
async function copyFixture(): Promise<string> {
  // rinka を解決できるように、コピーは tests/e2e の中に置く
  const copy = await mkdtemp(fileURLToPath(new URL("../.rinka-tmp-", import.meta.url)));
  temporaries.push(copy);
  await cp(root, copy, { recursive: true });
  return copy;
}

/** アプリのルート `copy` の `src/` からの相対パス `file` に、`lines` を行とするファイルを作成する。 */
async function addFile(copy: string, file: string, lines: readonly string[]): Promise<void> {
  await mkdir(dirname(join(copy, "src", file)), { recursive: true });
  await writeFile(join(copy, "src", file), [...lines, ""].join("\n"));
}

describe("output: 'static'", () => {
  it("prerender の無いパラメータの無いページも書き出し、not-found.tsx を 404.html に保存して、dist/server を削除する", async () => {
    const outDir = join(await temporary(), "dist");
    await buildFixture(root, outDir, { output: "static" });
    const written = (path: string) => readFile(join(outDir, "client", path), "utf8");
    expect(await written("dynamic/index.html")).toContain("<h1>dynamic</h1>");
    expect(await written("posts/hello/index.html")).toContain("<h1>post hello</h1>");
    expect(await written("404.html")).toContain("<h1>missing</h1>");
    expect(existsSync(join(outDir, "server"))).toBe(false);
    const server = await preview({
      root,
      configFile: false,
      logLevel: "error",
      plugins: [rinka({ prefix: "app", outDir, output: "static" })],
      preview: { port: 0 },
    });
    try {
      const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
      const about = await fetch(`${origin}/about`);
      expect([about.status, await about.text()]).toEqual([200, await written("about/index.html")]);
      const missing = await fetch(`${origin}/nope`);
      expect([missing.status, await missing.text()]).toEqual([404, await written("404.html")]);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("ルートのキャッチオールのページがあっても、ルートの middleware.ts を実行してから描画した not-found.tsx を 404.html に保存する", async () => {
    const copy = await copyFixture();
    await addFile(copy, "routes/[...slug]/page.tsx", [
      'export const prerender = () => [{ slug: "x/y" }];',
      "export default function All() {",
      "  return <h1>all</h1>;",
      "}",
    ]);
    await addFile(copy, "routes/middleware.ts", [
      "export default async (c, next) => {",
      '  c.set("who", "mw");',
      "  await next();",
      "};",
    ]);
    await addFile(copy, "routes/layout.tsx", [
      'import { getContext } from "rinka/server";',
      "export default function Layout(props) {",
      '  return <main data-who={String(getContext()?.get("who"))}>{props.children}</main>;',
      "}",
    ]);
    await buildFixture(copy, join(copy, "dist"), { output: "static" });
    expect(await readFile(join(copy, "dist/client/x/y/index.html"), "utf8")).toContain(
      "<h1>all</h1>",
    );
    expect(await readFile(join(copy, "dist/client/404.html"), "utf8")).toContain(
      '<main data-who="mw"><h1>missing</h1></main>',
    );
  }, 60_000);

  it("サーバー関数を定義したファイルがあれば、ファイルの名前を含むビルドのエラーにする", async () => {
    const copy = await copyFixture();
    await addFile(copy, "lib/fns.ts", [
      'import { defineServerFn } from "rinka/server";',
      "export const save = defineServerFn(() => 1);",
    ]);
    await expect(buildFixture(copy, join(copy, "dist"), { output: "static" })).rejects.toThrow(
      "src/lib/fns.ts",
    );
  }, 60_000);

  it("パラメータのあるページに prerender が無ければ、ファイルの名前を含むビルドのエラーにする", async () => {
    const copy = await copyFixture();
    await addFile(copy, "routes/users/[id]/page.tsx", [
      "export default function User() {",
      "  return <h1>user</h1>;",
      "}",
    ]);
    await expect(buildFixture(copy, join(copy, "dist"), { output: "static" })).rejects.toThrow(
      "src/routes/users/[id]/page.tsx",
    );
  }, 60_000);

  it("開発サーバーは、prerender が返していないパラメータの URL に 404 を返す", async () => {
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "error",
      server: { hmr: false, port: 0 },
      cacheDir: join(await temporary(), "vite"),
      plugins: [rinka({ prefix: "app", output: "static" })],
    });
    await server.listen();
    try {
      const origin = originOf(server);
      const listed = await fetch(`${origin}/posts/hello`);
      expect([listed.status, await listed.text()]).toEqual([
        200,
        expect.stringContaining("<h1>post hello</h1>"),
      ]);
      const encoded = await fetch(`${origin}/posts/%e6%97%a5%e6%9c%ac`);
      expect([encoded.status, await encoded.text()]).toEqual([
        200,
        expect.stringContaining("<h1>post 日本</h1>"),
      ]);
      const unlisted = await fetch(`${origin}/posts/other`);
      expect([unlisted.status, await unlisted.text()]).toEqual([
        404,
        expect.stringContaining("<h1>missing</h1>"),
      ]);
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe("書き出しの失敗", () => {
  it("書き出す URL のレスポンスが 200 でなければ、URL とステータスを含むビルドのエラーにする", async () => {
    const copy = await copyFixture();
    await addFile(copy, "routes/missing/[id]/page.tsx", [
      'import { notFound } from "rinka/server";',
      'export const prerender = () => [{ id: "gone" }];',
      "export default function Missing() {",
      "  throw notFound();",
      "}",
    ]);
    await expect(buildFixture(copy, join(copy, "dist"))).rejects.toThrow(
      "/missing/gone を書き出すと、ステータスが 404 になりました。",
    );
  }, 60_000);
});

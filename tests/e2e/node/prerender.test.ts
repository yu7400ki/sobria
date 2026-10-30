import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sobria } from "sobria/vite";
import { createServer, preview, type Plugin } from "vite";
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
  const dir = await mkdtemp(join(tmpdir(), "sobria-prerender-"));
  temporaries.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(temporaries.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("登録した拡張子のページの書き出し", () => {
  /** 拡張子が `.page` のファイルの先頭の行 `@page` を取り除いて、TSX のソースにするテスト用のプラグインである。 */
  const pagePlugin: Plugin = {
    name: "test:page",
    enforce: "pre",
    transform: (code, id) => (id.endsWith(".page") ? code.replace(/^@page\n/, "") : null),
  };

  it("prerender を export するページを書き出し、export しないページはサーバーのエントリーが描画する", async () => {
    const project = await temporary();
    const files = {
      "src/routes/layout.page":
        "@page\nexport default function Layout(props: { children?: unknown }) { return <main>{props.children}</main>; }\n",
      "src/routes/page.page":
        "@page\nexport const prerender = true;\nexport default function Page() { return <h1>home</h1>; }\n",
      "src/routes/dynamic/page.page":
        "@page\nexport default function Dynamic() { return <h1>dynamic</h1>; }\n",
    };
    await Promise.all(
      Object.entries(files).map(async ([file, source]) => {
        await mkdir(dirname(join(project, file)), { recursive: true });
        await writeFile(join(project, file), source);
      }),
    );
    const outDir = join(project, "dist");
    await buildFixture(project, outDir, { extensions: [".page"] }, [pagePlugin]);
    expect(await readFile(join(outDir, "client/index.html"), "utf8")).toContain(
      "<main><h1>home</h1></main>",
    );
    expect(existsSync(join(outDir, "client/dynamic"))).toBe(false);
    const module = (await import(pathToFileURL(join(outDir, "server/entry.js")).href)) as {
      default: App;
    };
    const response = await module.default.fetch(new Request("http://localhost/dynamic"));
    expect(await response.text()).toContain("<main><h1>dynamic</h1></main>");
  }, 60_000);

  it("書き出す URL が無ければ、ビルドの中でサーバーのエントリーを読み込まない", async () => {
    const project = await temporary();
    const files = {
      "src/server.ts":
        'import app from "sobria/app";\nReflect.set(globalThis, "sobriaEntryLoaded", true);\nexport default app;\n',
      "src/routes/page.page": "@page\nexport default function Page() { return <h1>home</h1>; }\n",
    };
    await Promise.all(
      Object.entries(files).map(async ([file, source]) => {
        await mkdir(dirname(join(project, file)), { recursive: true });
        await writeFile(join(project, file), source);
      }),
    );
    await buildFixture(project, join(project, "dist"), { extensions: [".page"] }, [pagePlugin]);
    expect(Reflect.get(globalThis, "sobriaEntryLoaded")).toBeUndefined();
    expect(existsSync(join(project, "dist/client/index.html"))).toBe(false);
  }, 60_000);
});

describe("type が commonjs のアプリのビルド", () => {
  it("サーバーのエントリーを entry.js にし、ES モジュールとして読み込めるようにする", async () => {
    const project = await temporary();
    const files = {
      "package.json": JSON.stringify({ type: "commonjs" }),
      "src/routes/page.tsx":
        "export const prerender = true;\nexport default function Page() { return <h1>home</h1>; }\n",
      "src/routes/dynamic/page.tsx":
        "export default function Dynamic() { return <h1>dynamic</h1>; }\n",
    };
    await Promise.all(
      Object.entries(files).map(async ([file, source]) => {
        await mkdir(dirname(join(project, file)), { recursive: true });
        await writeFile(join(project, file), source);
      }),
    );
    const outDir = join(project, "dist");
    await buildFixture(project, outDir);
    expect(await readFile(join(outDir, "client/index.html"), "utf8")).toContain("<h1>home</h1>");
    expect(JSON.parse(await readFile(join(outDir, "server/package.json"), "utf8"))).toEqual({
      type: "module",
    });
    const module = (await import(pathToFileURL(join(outDir, "server/entry.js")).href)) as {
      default: App;
    };
    const response = await module.default.fetch(new Request("http://localhost/dynamic"));
    expect(await response.text()).toContain("<h1>dynamic</h1>");
  }, 60_000);
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
      plugins: [sobria({ prefix: "app", outDir })],
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
  // sobria を解決できるように、コピーは tests/e2e の中に置く
  const copy = await mkdtemp(fileURLToPath(new URL("../.sobria-tmp-", import.meta.url)));
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
    // 書き出しで読み込んだサーバーのエントリーが import のキャッシュに残っていても、404.html のファイルから返したことを印で確認する
    await appendFile(join(outDir, "client/404.html"), "<!-- written -->");
    const server = await preview({
      root,
      configFile: false,
      logLevel: "error",
      plugins: [sobria({ prefix: "app", outDir, output: "static" })],
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
      'import { getContext } from "sobria/server";',
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

  it("404.html の <head> に、not-found.tsx とレイアウトが import した CSS の <link> を出力する", async () => {
    const copy = await copyFixture();
    await addFile(copy, "routes/layout.css", [".layout-style { color: rgb(1, 2, 3); }"]);
    await addFile(copy, "routes/not-found.css", [".not-found-style { color: rgb(4, 5, 6); }"]);
    await addFile(copy, "routes/layout.tsx", [
      'import "./layout.css";',
      "export default function Layout(props) {",
      "  return <main>{props.children}</main>;",
      "}",
    ]);
    await addFile(copy, "routes/not-found.tsx", [
      'import "./not-found.css";',
      "export default function Missing() {",
      "  return <h1>missing</h1>;",
      "}",
    ]);
    await buildFixture(copy, join(copy, "dist"), { output: "static" });
    const html = await readFile(join(copy, "dist/client/404.html"), "utf8");
    const links = [
      ...html.slice(0, html.indexOf("</head>")).matchAll(/<link rel="stylesheet" href="([^"]+)">/g),
    ].map((match) => match[1]!);
    expect(links.every((link) => /^\/assets\/[^/]+\.css$/.test(link))).toBe(true);
    const css = (
      await Promise.all(links.map((link) => readFile(join(copy, "dist/client", link), "utf8")))
    ).join("\n");
    expect(css).toContain(".layout-style");
    expect(css).toContain(".not-found-style");
  }, 60_000);

  it("サーバー関数を定義したファイルがあれば、ファイルの名前を含むビルドのエラーにする", async () => {
    const copy = await copyFixture();
    await addFile(copy, "lib/fns.ts", [
      'import { defineServerFn } from "sobria/server";',
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
      plugins: [sobria({ prefix: "app", output: "static" })],
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
      'import { notFound } from "sobria/server";',
      'export const prerender = () => [{ id: "gone" }];',
      "export default function Missing() {",
      "  throw notFound();",
      "}",
    ]);
    await expect(buildFixture(copy, join(copy, "dist"))).rejects.toThrow(
      "/missing/gone を書き出すと、ステータスが 404 になりました。",
    );
  }, 60_000);

  it("output: 'static' で、404.html を取得するリクエストのレスポンスが 404 でなければ、ステータスを含むビルドのエラーにする", async () => {
    const copy = await copyFixture();
    await addFile(copy, "routes/middleware.ts", [
      'import { redirect } from "sobria/server";',
      "export default async (c, next) => {",
      '  if (c.req.path.startsWith("/_sobria/")) throw redirect("/");',
      "  await next();",
      "};",
    ]);
    await expect(buildFixture(copy, join(copy, "dist"), { output: "static" })).rejects.toThrow(
      "ステータスが 303 になりました。",
    );
  }, 60_000);

  it("output: 'static' で、public/404.html があれば、ファイルの名前を含むビルドのエラーにする", async () => {
    const copy = await copyFixture();
    await mkdir(join(copy, "public"), { recursive: true });
    await writeFile(join(copy, "public/404.html"), "<h1>custom</h1>");
    await expect(buildFixture(copy, join(copy, "dist"), { output: "static" })).rejects.toThrow(
      "404.html",
    );
  }, 60_000);
});

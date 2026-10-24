import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rinka } from "rinka/vite";
import { preview } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

describe("書き出しの失敗", () => {
  it("書き出す URL のレスポンスが 200 でなければ、URL とステータスを含むビルドのエラーにする", async () => {
    // rinka を解決できるように、コピーは tests/e2e の中に置く
    const copy = await mkdtemp(fileURLToPath(new URL("../.rinka-tmp-", import.meta.url)));
    temporaries.push(copy);
    await cp(root, copy, { recursive: true });
    await mkdir(join(copy, "src/routes/missing/[id]"), { recursive: true });
    await writeFile(
      join(copy, "src/routes/missing/[id]/page.tsx"),
      [
        'import { notFound } from "rinka/server";',
        'export const prerender = () => [{ id: "gone" }];',
        "export default function Missing() {",
        "  throw notFound();",
        "}",
        "",
      ].join("\n"),
    );
    await expect(buildFixture(copy, join(copy, "dist"))).rejects.toThrow(
      "/missing/gone を書き出すと、ステータスが 404 になりました。",
    );
  }, 60_000);
});

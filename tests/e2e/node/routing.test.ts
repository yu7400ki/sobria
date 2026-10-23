import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import { createDevServer, originOf } from "../dev-server.ts";

const root = fileURLToPath(new URL("../fixtures/routing", import.meta.url));

let server: ViteDevServer;
let origin: string;

beforeAll(async () => {
  server = await createDevServer(root, {
    server: { port: 0 },
    cacheDir: fileURLToPath(new URL("../node_modules/.vite/node-routing", import.meta.url)),
  });
  await server.listen();
  origin = originOf(server);
});

afterAll(async () => {
  await server.close();
});

/** 開発サーバーの `path` にリクエストを送り、ステータスと、`<body>` の中身と、`headers` の値を返す。 */
async function get(path: string, init?: RequestInit, headers: readonly string[] = []) {
  const response = await fetch(`${origin}${path}`, init);
  const text = await response.text();
  const body = (/<body>(.*)<\/body>/s.exec(text)?.[1] ?? text).replaceAll("<!-- -->", "");
  return {
    status: response.status,
    body,
    headers: headers.map((name) => response.headers.get(name)),
  };
}

describe("ルーティング", () => {
  it("ページを、ルートのレイアウトで包み、ルートの middleware.ts を適用して返す", async () => {
    const { status, body, headers } = await get("/", undefined, ["x-root"]);
    expect([status, headers]).toEqual([200, ["1"]]);
    expect(body).toContain('<div id="root"><main><h1>home</h1><a href="/users/1">first</a>');
    expect(body).toContain('href="/users/2"');
  });

  it("動的な区切りのページに params と url を渡し、ディレクトリのレイアウトと middleware.ts を適用する", async () => {
    const { status, body, headers } = await get(
      "/users/5?tab=posts",
      { headers: { "x-name": "ann" } },
      ["x-root", "x-users"],
    );
    expect([status, headers]).toEqual([200, ["1", "1"]]);
    expect(body).toContain(
      '<div id="root"><section id="users"><p>user 5 posts ann</p></section></div>',
    );
  });

  it("静的な区切りを動的な区切りより優先し、グループのレイアウトとキャッチオールを扱う", async () => {
    const pages = await Promise.all(
      ["/users/new", "/about", "/docs/a/b"].map((path) => get(path, undefined, ["x-users"])),
    );
    expect(
      pages.map(({ status, body, headers }) => [
        status,
        /<div id="root">(.*)<\/div>/s.exec(body)?.[1],
        headers[0],
      ]),
    ).toEqual([
      [200, '<section id="users"><p>new user</p></section>', "1"],
      [200, '<article id="marketing"><p>about</p></article>', null],
      [200, "<p>doc a/b</p>", null],
    ]);
  });

  it("route.ts は、戻り値を JSON にし、undefined を 204 にし、export の無いメソッドに 405 を返す", async () => {
    const [got, deleted, put] = await Promise.all([
      fetch(`${origin}/api/items/7`),
      fetch(`${origin}/api/items/7`, { method: "DELETE" }),
      fetch(`${origin}/api/items/7`, { method: "PUT" }),
    ]);
    expect([got.status, got.headers.get("x-root"), await got.json()]).toEqual([
      200,
      "1",
      { id: "7" },
    ]);
    expect([deleted.status, put.status, put.headers.get("allow")]).toEqual([
      204,
      405,
      "GET, HEAD, DELETE",
    ]);
  });

  it("notFound() と表に無い URL には最も近い not-found.tsx を、エラーには最も近い error.tsx を返す", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    const pages = await Promise.all(
      ["/users/0", "/users/9/x", "/nothing", "/users/boom", "/boom"].map((path) => get(path)),
    );
    expect(pages.map(({ status, body }) => [status, /<h1>(.*)<\/h1>/.exec(body)?.[1]])).toEqual([
      [404, "user not found"],
      [404, "user not found"],
      [404, "root not found /nothing"],
      [500, "user error user boom"],
      [500, "root error boom"],
    ]);
    expect(pages[0]?.body).toContain('<section id="users">');
  });

  it("要素は、クライアントの環境でも rinka/router を import できる", async () => {
    const result = await server.environments.client.transformRequest("/src/elements/user-link.tsx");
    expect(result?.code).toMatch(/from "[^"]*\/lib\/shared\/router\.js"/);
  });

  it("ページのファイルを追加と削除したら、開発サーバーを再起動せずにルートの表を作り直す", async () => {
    const dir = join(root, "src/routes/added");
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(
        join(dir, "page.tsx"),
        "export default function Added() {\n  return <p>added</p>;\n}\n",
      );
      await vi.waitFor(async () => expect((await get("/added")).body).toContain("<p>added</p>"), {
        timeout: 10_000,
        interval: 200,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    await vi.waitFor(async () => expect((await get("/added")).status).toBe(404), {
      timeout: 10_000,
      interval: 200,
    });
  }, 30_000);
});

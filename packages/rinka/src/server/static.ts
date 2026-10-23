import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "hono/serve-static";

/** ビルドしたアプリを表す。 */
interface App {
  fetch(request: Request): Response | Promise<Response>;
}

/**
 * ディレクトリ `clientDir` のファイルを配信し、それ以外のリクエストを `app` に渡す fetch を返す。
 * `/assets/` のファイルには、変更されない前提のキャッシュの指定を付与する。`/.vite/` のファイルは配信しない。
 */
export function serveClient(
  clientDir: string,
  app: App,
): (request: Request) => Response | Promise<Response> {
  const server = new Hono();
  server.all("/.vite/*", (c) => app.fetch(c.req.raw));
  server.use(
    "*",
    serveStatic({
      root: clientDir,
      join,
      getContent: async (path) => readFile(path).catch(() => null),
      isDir: async (path) => (await stat(path).catch(() => undefined))?.isDirectory(),
      onFound: (path, c) => {
        if (path.startsWith(join(clientDir, "assets"))) {
          c.header("cache-control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );
  server.all("*", (c) => app.fetch(c.req.raw));
  return server.fetch;
}

/** ポートの番号である。環境変数 `PORT` が無ければ 3000 にする。 */
const port = (): number => Number(process.env.PORT ?? 3000);

/** `index.js` の URL `base` からの相対パスの `../client` を配信し、`app` に応答させるサーバーを、Node で起動する。 */
export function serveNode(app: App, base: string): void {
  serve({ fetch: serveClient(fileURLToPath(new URL("../client", base)), app), port: port() });
}

/** `index.js` の URL `base` からの相対パスの `../client` を配信し、`app` に応答させるサーバーを、Bun で起動する。 */
export function serveBun(app: App, base: string): void {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const bun = (globalThis as unknown as { Bun: { serve(options: object): void } }).Bun;
  bun.serve({ fetch: serveClient(fileURLToPath(new URL("../client", base)), app), port: port() });
}

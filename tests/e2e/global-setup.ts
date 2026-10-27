import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { mergeConfig, type InlineConfig, type ViteDevServer } from "vite";
import type { TestProject } from "vitest/node";

import { createDevServer, originOf, stylesConfig } from "./dev-server.ts";
import { buildFixture } from "./node/production.ts";

declare module "vitest" {
  interface ProvidedContext {
    /** テスト用のアプリ `fixtures/basic` の開発サーバーのオリジンである。 */
    basicOrigin: string;
    /** `fixtures/basic` の開発サーバーが返した `/` の HTML である。 */
    basicPage: string;
    /** `fixtures/basic` の開発サーバーが返した `/nested` の HTML である。 */
    nestedPage: string;
    /** `fixtures/basic` の開発サーバーが返した `/load` の HTML である。 */
    loadPage: string;
    /** `fixtures/basic` の開発サーバーが返した `/stream` の HTML である。 */
    streamPage: string;
    /** テスト用のアプリ `fixtures/styles` の開発サーバーのオリジンである。 */
    stylesOrigin: string;
    /** `fixtures/styles` の開発サーバーが返した `/` の HTML である。 */
    stylesPage: string;
    /** `tests/fixture-library` を `library: true` でビルドした出力先の、`/` で区切った絶対パスである。 */
    libraryDir: string;
  }
}

/** `origin` の `path` のページの HTML を返す。 */
async function page(origin: string, path: string): Promise<string> {
  const response = await fetch(`${origin}${path}`);
  if (!response.ok) {
    throw new Error(`${origin} の ${path} のページが ${response.status} を返しました。`);
  }
  return response.text();
}

/** `fixtures/<name>` の開発サーバーを起動し、オリジンを返す。 */
async function start(
  name: string,
  servers: ViteDevServer[],
  config: InlineConfig = {},
): Promise<string> {
  const server = await createDevServer(
    fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)),
    mergeConfig({ server: { port: 0 } }, config),
  );
  servers.push(server);
  await server.listen();
  return originOf(server);
}

/**
 * `fixtures/basic` と `fixtures/styles` の開発サーバーを起動し、オリジンとページの HTML をテストに渡す。
 * `tests/fixture-library` を、テストのページが `/@fs/` で読み込める `tests/e2e` の中にビルドし、出力先をテストに渡す。
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const servers: ViteDevServer[] = [];
  const library = await mkdtemp(fileURLToPath(new URL(".rinka-tmp-library-", import.meta.url)));
  const close = async () => {
    await Promise.all(servers.map((server) => server.close()));
    await rm(library, { recursive: true, force: true });
  };
  try {
    // テストのページは開発サーバーと別のオリジンの iframe なので、RPC のレスポンスのヘッダーを読めるように公開する
    const basic = await start("basic", servers, { server: { cors: { exposedHeaders: "*" } } });
    project.provide("basicOrigin", basic);
    project.provide("basicPage", await page(basic, "/"));
    project.provide("nestedPage", await page(basic, "/nested"));
    project.provide("loadPage", await page(basic, "/load"));
    project.provide("streamPage", await page(basic, "/stream"));
    const styles = await start("styles", servers, stylesConfig());
    project.provide("stylesOrigin", styles);
    project.provide("stylesPage", await page(styles, "/"));
    await buildFixture(fileURLToPath(new URL("../fixture-library", import.meta.url)), library, {
      prefix: "acme",
      library: true,
    });
    project.provide("libraryDir", library.replaceAll("\\", "/"));
  } catch (error) {
    await close();
    throw error;
  }
  return close;
}

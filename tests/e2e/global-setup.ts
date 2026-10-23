import { fileURLToPath } from "node:url";

import type { ViteDevServer } from "vite";
import type { TestProject } from "vitest/node";

import { createDevServer, originOf } from "./dev-server.ts";

declare module "vitest" {
  interface ProvidedContext {
    /** テスト用のアプリ `fixtures/basic` の開発サーバーのオリジンである。 */
    basicOrigin: string;
    /** `fixtures/basic` の開発サーバーが返した `/` の HTML である。 */
    basicPage: string;
    /** `fixtures/basic` の開発サーバーが返した `/load` の HTML である。 */
    loadPage: string;
    /** テスト用のアプリ `fixtures/styles` の開発サーバーのオリジンである。 */
    stylesOrigin: string;
    /** `fixtures/styles` の開発サーバーが返した `/` の HTML である。 */
    stylesPage: string;
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
async function start(name: string, servers: ViteDevServer[]): Promise<string> {
  const server = await createDevServer(
    fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)),
    {
      server: { port: 0 },
    },
  );
  servers.push(server);
  await server.listen();
  return originOf(server);
}

/** `fixtures/basic` と `fixtures/styles` の開発サーバーを起動し、オリジンとページの HTML をテストに渡す。 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const servers: ViteDevServer[] = [];
  const close = async () => {
    await Promise.all(servers.map((server) => server.close()));
  };
  try {
    const basic = await start("basic", servers);
    project.provide("basicOrigin", basic);
    project.provide("basicPage", await page(basic, "/"));
    project.provide("loadPage", await page(basic, "/load"));
    const styles = await start("styles", servers);
    project.provide("stylesOrigin", styles);
    project.provide("stylesPage", await page(styles, "/"));
  } catch (error) {
    await close();
    throw error;
  }
  return close;
}

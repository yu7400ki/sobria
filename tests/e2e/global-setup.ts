import { fileURLToPath } from "node:url";

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
  }
}

/** `origin` の `path` のページの HTML を返す。 */
async function page(origin: string, path: string): Promise<string> {
  const response = await fetch(`${origin}${path}`);
  if (!response.ok) {
    throw new Error(`fixtures/basic の ${path} のページが ${response.status} を返しました。`);
  }
  return response.text();
}

/** `fixtures/basic` の開発サーバーを起動し、オリジンとページの HTML をテストに渡す。 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = await createDevServer(fileURLToPath(new URL("fixtures/basic", import.meta.url)), {
    server: { port: 0 },
  });
  try {
    await server.listen();
    const origin = originOf(server);
    project.provide("basicOrigin", origin);
    project.provide("basicPage", await page(origin, "/"));
    project.provide("loadPage", await page(origin, "/load"));
  } catch (error) {
    await server.close();
    throw error;
  }
  return () => server.close();
}

import { fileURLToPath } from "node:url";

import type { TestProject } from "vitest/node";

import { createDevServer, originOf } from "./dev-server.ts";

declare module "vitest" {
  interface ProvidedContext {
    /** テスト用のアプリ `fixtures/basic` の開発サーバーのオリジンである。 */
    basicOrigin: string;
    /** `fixtures/basic` の開発サーバーが返した `/` の HTML である。 */
    basicPage: string;
  }
}

/** `fixtures/basic` の開発サーバーを起動し、オリジンとページの HTML をテストに渡す。 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = await createDevServer(fileURLToPath(new URL("fixtures/basic", import.meta.url)), {
    server: { port: 0 },
  });
  try {
    await server.listen();
    const origin = originOf(server);
    const response = await fetch(`${origin}/`);
    if (!response.ok)
      throw new Error(`fixtures/basic のページが ${response.status} を返しました。`);
    project.provide("basicOrigin", origin);
    project.provide("basicPage", await response.text());
  } catch (error) {
    await server.close();
    throw error;
  }
  return () => server.close();
}

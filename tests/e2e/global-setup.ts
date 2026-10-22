import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { rinka } from "rinka/vite";
import { createServer } from "vite";
import type { TestProject } from "vitest/node";

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
  const server = await createServer({
    root: fileURLToPath(new URL("fixtures/basic", import.meta.url)),
    configFile: false,
    logLevel: "error",
    server: { port: 0, hmr: false },
    plugins: [rinka({ prefix: "app" })],
  });
  try {
    await server.listen();
    const address = server.httpServer?.address() as AddressInfo | null | undefined;
    if (!address) throw new Error("開発サーバーのアドレスを取得できません。");
    const { port } = address;
    const origin = `http://localhost:${port}`;
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

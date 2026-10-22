import type { AddressInfo } from "node:net";

import { rinka } from "rinka/vite";
import { createServer, mergeConfig, type InlineConfig, type ViteDevServer } from "vite";

/**
 * `root` のアプリの開発サーバーを、rinka のプラグイン（接頭辞は `app`）を登録し、HMR を無効にして作成する。
 * `config` は Vite の `mergeConfig` でこの設定に重ねるので、`plugins` に記述したプラグインは rinka のプラグインの後ろに追加する。
 */
export function createDevServer(root: string, config: InlineConfig = {}): Promise<ViteDevServer> {
  const base: InlineConfig = {
    root,
    configFile: false,
    logLevel: "error",
    server: { hmr: false },
    plugins: [rinka({ prefix: "app" })],
  };
  return createServer(mergeConfig(base, config));
}

/** `listen` した開発サーバーのオリジンを返す。 */
export function originOf(server: ViteDevServer): string {
  const address = server.httpServer?.address() as AddressInfo | null | undefined;
  if (!address || typeof address !== "object") {
    throw new Error("開発サーバーのアドレスを取得できません。");
  }
  return `http://localhost:${address.port}`;
}

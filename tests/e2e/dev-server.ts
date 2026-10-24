import type { AddressInfo } from "node:net";

import tailwindcss from "@tailwindcss/vite";
import { rinka, type RinkaOptions } from "rinka/vite";
import {
  createServer,
  mergeConfig,
  type InlineConfig,
  type PluginOption,
  type ViteDevServer,
} from "vite";

/** 開発サーバーの rinka のプラグインに渡す設定と、rinka のプラグインより前に登録するプラグインを表す。 */
export interface RinkaSetup {
  readonly options?: RinkaOptions;
  readonly before?: readonly PluginOption[];
}

/**
 * `root` のアプリの開発サーバーを、rinka のプラグイン（接頭辞は `app`）を登録し、HMR を無効にして作成する。
 * `config` は Vite の `mergeConfig` でこの設定に重ねるので、`plugins` に記述したプラグインは rinka のプラグインの後ろに追加する。
 * `setup` の `options` は rinka のプラグインの設定に重ね、`before` のプラグインは rinka のプラグインの前に登録する。
 */
export function createDevServer(
  root: string,
  config: InlineConfig = {},
  setup: RinkaSetup = {},
): Promise<ViteDevServer> {
  const base: InlineConfig = {
    root,
    configFile: false,
    logLevel: "error",
    server: { hmr: false },
    plugins: [...(setup.before ?? []), rinka({ prefix: "app", ...setup.options })],
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

/** テスト用のアプリ `fixtures/styles` の開発サーバーに重ねる設定である。 */
export const stylesConfig = (): InlineConfig => ({ plugins: [tailwindcss()] });

import type { AddressInfo } from "node:net";

import tailwindcss from "@tailwindcss/vite";
import { sobria, type SobriaOptions } from "sobria/vite";
import {
  createServer,
  mergeConfig,
  type InlineConfig,
  type PluginOption,
  type ViteDevServer,
} from "vite";

/** 開発サーバーの sobria のプラグインに渡す設定と、sobria のプラグインより前に登録するプラグインを表す。 */
export interface SobriaSetup {
  readonly options?: SobriaOptions;
  readonly before?: readonly PluginOption[];
}

/**
 * `root` のアプリの開発サーバーを、sobria のプラグイン（接頭辞は `app`）を登録し、HMR を無効にして作成する。
 * `config` は Vite の `mergeConfig` でこの設定に重ねるので、`plugins` に記述したプラグインは sobria のプラグインの後ろに追加する。
 * `setup` の `options` は sobria のプラグインの設定に重ね、`before` のプラグインは sobria のプラグインの前に登録する。
 * `config` の `cacheDir` には、ほかの開発サーバーが使用しないディレクトリを指定する。Vite は依存を事前バンドルした結果をこのディレクトリに書き込むので、並行して動く開発サーバーが同じディレクトリを使用すると、書き込みが競合する。
 */
export function createDevServer(
  root: string,
  config: InlineConfig & { readonly cacheDir: string },
  setup: SobriaSetup = {},
): Promise<ViteDevServer> {
  const base: InlineConfig = {
    root,
    configFile: false,
    logLevel: "error",
    server: { hmr: false },
    plugins: [...(setup.before ?? []), sobria({ prefix: "app", ...setup.options })],
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

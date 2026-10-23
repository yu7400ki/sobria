import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AppOptions } from "../shared/routes.ts";
import { entries } from "./entries.ts";

/** `rinka/app` の中で、ビルドの最後にルートのファイルごとの CSS の一覧に置き換える文字列である。 */
export const STYLES_MARKER = "__rinka_route_styles__";

/** アプリが記述するサーバーのエントリーの、アプリのルートからの相対パスである。 */
const SERVER_FILE = "src/server.ts";

/** アプリのルート `root` に `src/server.ts` があれば `/src/server.ts` を、無ければ `rinka/app` を返す。 */
export function serverEntry(root: string): string {
  return existsSync(join(root, SERVER_FILE)) ? `/${SERVER_FILE}` : entries.app;
}

/** 開発サーバーが Vite のプロセスで実行し、`rinka/app` が使用する関数を表す。 */
export type DevHooks = Required<Pick<AppOptions, "styles" | "onError" | "loadServerFn">>;

/** 開発中の `rinka/app` が、プラグインのインスタンスの ID ごとの `DevHooks` を探す、グローバルの Map のキーである。 */
const DEV_HOOKS = "rinka.dev";

/** プラグインのインスタンスの ID ごとの `DevHooks` を保持する、グローバルの Map を返す。 */
export function devHooks(): Map<string, DevHooks> {
  const global = globalThis as { [key: symbol]: Map<string, DevHooks> | undefined };
  return (global[Symbol.for(DEV_HOOKS)] ??= new Map<string, DevHooks>());
}

/** 開発中のページの `<head>` に出力する、Vite のクライアントを読み込むスクリプトである。 */
const VITE_CLIENT = '<script type="module" src="/@vite/client"></script>';

/** `rinka/app` を生成する入力を表す。 */
export interface AppModuleOptions {
  /** ID のモジュールの部分ごとの、サーバー関数を定義したモジュールの、ルートからの相対パスである。 */
  readonly serverFns: ReadonlyMap<string, string>;
  /** 別のサイトからでも受け付けるオリジンである。 */
  readonly trustedOrigins: readonly string[];
  /** 開発中なら、`DevHooks` を探すプラグインのインスタンスの ID である。 */
  readonly dev?: string;
}

/**
 * 生成した時点のルートの表とサーバー関数の一覧からアプリを作成し、default で export する `rinka/app` のコードを返す。
 * 開発中のアプリは、Vite のクライアントを読み込み、`DevHooks` があればそれを使用する。
 */
export function appModule({ serverFns, trustedOrigins, dev }: AppModuleOptions): string {
  const loaders = [...serverFns].map(
    ([fnModule, file]) =>
      `    ${JSON.stringify(fnModule)}: () => import(${JSON.stringify(`/${file}`)}),\n`,
  );
  const loader = `serverFnLoader({\n${loaders.join("")}  })`;
  const options =
    dev === undefined
      ? [`  styles: routeStyles(${JSON.stringify(STYLES_MARKER)}),`, `  loadServerFn: ${loader},`]
      : [
          `  head: ${JSON.stringify(VITE_CLIENT)},`,
          "  styles: hooks?.styles,",
          "  onError: hooks?.onError,",
          `  loadServerFn: hooks?.loadServerFn ?? ${loader},`,
        ];
  return [
    `import { createApp, routeStyles, serverFnLoader } from "${entries.internal}";`,
    `import * as routes from "${entries.routes}";`,
    "",
    ...(dev === undefined
      ? []
      : [
          `const hooks = globalThis[Symbol.for(${JSON.stringify(DEV_HOOKS)})]?.get(${JSON.stringify(dev)});`,
          "",
        ]),
    "export default createApp(routes, {",
    ...options,
    `  trustedOrigins: ${JSON.stringify(trustedOrigins)},`,
    "});",
    "",
  ].join("\n");
}

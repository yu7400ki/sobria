import { existsSync } from "node:fs";
import { join } from "node:path";

import { entries } from "./entries.ts";

/** `rinka/app` の中で、ビルドの最後にルートのファイルごとの CSS の一覧に置き換える文字列である。 */
export const STYLES_MARKER = "__rinka_route_styles__";

/** アプリが記述するサーバーのエントリーの、アプリのルートからの相対パスである。 */
const SERVER_FILE = "src/server.ts";

/** アプリのルート `root` に `src/server.ts` があれば、そのルートからの相対パスを返す。無ければ undefined を返す。 */
export function serverEntry(root: string): string | undefined {
  return existsSync(join(root, SERVER_FILE)) ? SERVER_FILE : undefined;
}

/** `rinka/app` を生成する入力を表す。 */
export interface AppModuleOptions {
  /** ID のモジュールの部分ごとの、サーバー関数を定義したモジュールの、ルートからの相対パスである。 */
  readonly serverFns: ReadonlyMap<string, string>;
  /** 別のサイトからでも受け付けるオリジンである。 */
  readonly trustedOrigins: readonly string[];
}

/** `serverFns` のモジュールを読み込む `serverFnLoader` の呼び出しの式を返す。 */
export function serverFnLoaderCode(serverFns: ReadonlyMap<string, string>): string {
  const loaders = [...serverFns].map(
    ([fnModule, file]) =>
      `    ${JSON.stringify(fnModule)}: () => import(${JSON.stringify(`/${file}`)}),\n`,
  );
  return `serverFnLoader({\n${loaders.join("")}  })`;
}

/**
 * ルートの表からアプリを作成し、default で export する `rinka/app` のコードを返す。
 * `createApp` の設定には、`options` の行と `trustedOrigins` を記述し、`createApp` の呼び出しの前に `preamble` の行を置く。
 */
export function appCode(
  options: readonly string[],
  trustedOrigins: readonly string[],
  preamble: readonly string[] = [],
): string {
  return [
    `import { createApp, routeStyles, serverFnLoader } from "${entries.internal}";`,
    `import * as routes from "${entries.routes}";`,
    "",
    ...preamble,
    "export default createApp(routes, {",
    ...options,
    `  trustedOrigins: ${JSON.stringify(trustedOrigins)},`,
    "});",
    "",
  ].join("\n");
}

/** 本番のビルドの `rinka/app` のコードを返す。ルートのファイルごとの CSS の一覧は、ビルドの最後に埋め込む。 */
export const buildAppModule = ({ serverFns, trustedOrigins }: AppModuleOptions): string =>
  appCode(
    [
      `  styles: routeStyles(${JSON.stringify(STYLES_MARKER)}),`,
      `  loadServerFn: ${serverFnLoaderCode(serverFns)},`,
    ],
    trustedOrigins,
  );

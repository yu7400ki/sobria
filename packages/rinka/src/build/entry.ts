import { existsSync } from "node:fs";
import { join } from "node:path";

import { entries } from "./entries.ts";

/** `rinka/app` の中で、ビルドの最後にルートのファイルごとの CSS の一覧に置き換える文字列である。 */
export const STYLES_MARKER = "__rinka_route_styles__";

/** アプリが記述するサーバーのエントリーの、アプリのルートからの相対パスである。 */
const SERVER_FILE = "src/server.ts";

/** アプリのルート `root` の `src/server.ts` があればその絶対パスを、無ければ `rinka/app` を返す。 */
export function serverEntry(root: string): string {
  const file = join(root, SERVER_FILE);
  return existsSync(file) ? file : entries.app;
}

/** `rinka/app` を生成する入力を表す。 */
export interface AppModuleOptions {
  /** ID のモジュールの部分ごとの、サーバー関数を定義したモジュールの、ルートからの相対パスである。 */
  readonly serverFns: ReadonlyMap<string, string>;
  /** 別のサイトからでも受け付けるオリジンである。 */
  readonly trustedOrigins: readonly string[];
}

/** ビルドの時点のルートの表とサーバー関数の一覧からアプリを作成し、default で export する `rinka/app` のコードを返す。 */
export function appModule({ serverFns, trustedOrigins }: AppModuleOptions): string {
  const loaders = [...serverFns].map(
    ([fnModule, file]) =>
      `  ${JSON.stringify(fnModule)}: () => import(${JSON.stringify(`/${file}`)}),\n`,
  );
  return `import { createApp, routeStyles, serverFnLoader } from "${entries.internal}";
import * as routes from "${entries.routes}";

export default createApp(routes, {
  styles: routeStyles(${JSON.stringify(STYLES_MARKER)}),
  trustedOrigins: ${JSON.stringify(trustedOrigins)},
  loadServerFn: serverFnLoader({
${loaders.join("")}  }),
});
`;
}

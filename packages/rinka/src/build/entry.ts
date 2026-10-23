import { entries } from "./entries.ts";

/** サーバーのエントリーの中で、ビルドの最後にルートのファイルごとの CSS の一覧に置き換える文字列である。 */
export const STYLES_MARKER = "__rinka_route_styles__";

/** サーバーのエントリーを生成する入力を表す。 */
export interface EntryOptions {
  /** ID のモジュールの部分ごとの、サーバー関数を定義したモジュールの、ルートからの相対パスである。 */
  readonly serverFns: ReadonlyMap<string, string>;
  /** 別のサイトからでも受け付けるオリジンである。 */
  readonly trustedOrigins: readonly string[];
}

/** ビルドの時点のルートの表とサーバー関数の一覧からアプリを作成し、`app` と `default { fetch }` で export するサーバーのエントリーのコードを返す。 */
export function entryModule({ serverFns, trustedOrigins }: EntryOptions): string {
  const loaders = [...serverFns].map(
    ([fnModule, file]) =>
      `  ${JSON.stringify(fnModule)}: () => import(${JSON.stringify(`/${file}`)}),\n`,
  );
  return `import { createApp, routeStyles, serverFnLoader } from "${entries.internal}";
import * as routes from "${entries.routes}";

export const app = createApp(routes, {
  styles: routeStyles(${JSON.stringify(STYLES_MARKER)}),
  trustedOrigins: ${JSON.stringify(trustedOrigins)},
  loadServerFn: serverFnLoader({
${loaders.join("")}  }),
});

export default { fetch: app.fetch };
`;
}

/** `deploy` のランタイムで、`dist/client` を配信し、サーバーのエントリーのアプリに応答させるサーバーを起動する、起動用のエントリーのコードを返す。 */
export function serverIndexModule(deploy: "node" | "bun"): string {
  const serveName = deploy === "bun" ? "serveBun" : "serveNode";
  return `import { ${serveName} } from "${entries.static}";
import { app } from "${entries.entry}";

${serveName}(app, import.meta.url);
`;
}

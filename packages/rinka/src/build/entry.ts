import { entries } from "./entries.ts";

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
  return `import { createApp, serverFnLoader } from "${entries.internal}";
import * as routes from "${entries.routes}";

export const app = createApp(routes, {
  trustedOrigins: ${JSON.stringify(trustedOrigins)},
  loadServerFn: serverFnLoader({
${loaders.join("")}  }),
});

export default { fetch: (request) => app.fetch(request) };
`;
}

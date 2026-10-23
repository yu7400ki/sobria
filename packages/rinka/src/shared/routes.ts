/** ルートの表の 1 行を表す。`page` は、ページのモジュールを読み込む。 */
export interface Route {
  readonly path: string;
  readonly page: () => Promise<{ readonly default: (props: Record<string, never>) => unknown }>;
}

/** アプリの設定を表す。 */
export interface AppOptions {
  /** ページの `<head>` の末尾に出力するマークアップである。 */
  readonly head?: string;
  /** ページとサーバー関数のエンドポイントが投げた、rinka が扱わないエラーを受け取り、アプリが返す Response を返す。 */
  readonly onError?: (error: unknown) => Response;
  /** GET 以外のサーバー関数のリクエストで、別のサイトからでも受け付ける `Origin` を列挙する。 */
  readonly trustedOrigins?: readonly string[];
  /** プロジェクトからの相対パスで指定したモジュールに、サーバー関数の定義があれば読み込む。未登録のサーバー関数の ID の、モジュールの部分を受け取る。 */
  readonly loadModule?: (path: string) => Promise<unknown>;
}

/** ルートの表から、各ページを描画するアプリを作成する関数を表す。 */
export type CreateApp = (
  routes: readonly Route[],
  options?: AppOptions,
) => { readonly fetch: (request: Request) => Response | Promise<Response> };

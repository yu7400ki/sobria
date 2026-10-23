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
  /** サーバー関数のリクエストごとに ID を受け取り、その ID のサーバー関数の定義を読み込めたら真を返す。偽を返した ID のリクエストには 404 を返す。 */
  readonly loadServerFn?: (id: string) => Promise<boolean>;
}

/** ルートの表から、各ページを描画するアプリを作成する関数を表す。 */
export type CreateApp = (
  routes: readonly Route[],
  options?: AppOptions,
) => { readonly fetch: (request: Request) => Response | Promise<Response> };

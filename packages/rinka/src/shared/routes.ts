/** ルートの表の 1 行を表す。`page` は、ページのモジュールを読み込む。 */
export interface Route {
  readonly path: string;
  readonly page: () => Promise<{ readonly default: (props: Record<string, never>) => unknown }>;
}

/** アプリの設定を表す。 */
export interface AppOptions {
  /** ページの `<head>` の末尾に出力するマークアップである。 */
  readonly head?: string;
  /** ページの読み込みか描画で投げたエラーを受け取り、アプリが返す Response を返す。 */
  readonly onError?: (error: unknown) => Response;
}

/** ルートの表から、各ページを描画するアプリを作成する関数を表す。 */
export type CreateApp = (
  routes: readonly Route[],
  options?: AppOptions,
) => { readonly fetch: (request: Request) => Response | Promise<Response> };

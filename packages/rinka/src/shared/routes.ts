import type { Handler, MiddlewareHandler } from "hono";

/** ルートのファイルの種類を表す。 */
export type RouteKind = "page" | "route" | "not-found" | "error";

/** `route.ts` が export できる HTTP メソッドである。 */
export const routeMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** `route.ts` が export できる HTTP メソッドを表す。 */
export type RouteMethod = (typeof routeMethods)[number];

/** モジュールを読み込み、その default export を返す関数を表す。 */
export type Load<T> = () => Promise<{ readonly default: T }>;

/** ページ、レイアウト、エラーのページのコンポーネントを表す。 */
export type RouteComponent = (props: never) => unknown;

/** ルートの表の 1 行を表す。`layouts` と `middlewares` は、外側から順に列挙する。 */
export type Route = {
  /** Hono のパスである。 */
  readonly path: string;
  readonly layouts: readonly Load<RouteComponent>[];
  /** ルートのディレクトリ以外の `middleware.ts` である。 */
  readonly middlewares: readonly Load<MiddlewareHandler>[];
} & (
  | { readonly kind: Exclude<RouteKind, "route">; readonly load: Load<RouteComponent> }
  | {
      readonly kind: "route";
      readonly load: () => Promise<Partial<Readonly<Record<RouteMethod, Handler>>>>;
    }
);

/** ルートの表を表す。`middleware` は、ルートのディレクトリの `middleware.ts` を読み込む。 */
export interface Routes {
  readonly routes: readonly Route[];
  readonly middleware?: Load<MiddlewareHandler>;
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
  routes: Routes,
  options?: AppOptions,
) => { readonly fetch: (request: Request) => Response | Promise<Response> };

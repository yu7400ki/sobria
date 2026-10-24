import type { Handler, MiddlewareHandler } from "hono";

/** ルートのファイルの種類を表す。 */
export type RouteKind = "page" | "route" | "not-found";

/** `route.ts` が export できる HTTP メソッドである。 */
export const routeMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** `route.ts` が export できる HTTP メソッドを表す。 */
export type RouteMethod = (typeof routeMethods)[number];

/** モジュールを読み込み、その default export を返す関数を表す。`file` は、Vite プラグインが作成したルートの表で、モジュールのファイルのプロジェクトのルートからのパスである。 */
export type Load<T> = (() => Promise<{ readonly default: T }>) & { readonly file: string };

/** ページ、レイアウト、エラーのページのコンポーネントを表す。 */
export type RouteComponent = (props: never) => unknown;

/** ルートの表が参照するファイルを、コンポーネント、ミドルウェア、`route.ts` の種類ごとに表す型である。 */
export interface Files<C, M, H> {
  readonly component: C;
  readonly middleware: M;
  readonly handlers: H;
}

/** ファイルの種類ごとの型を限定しない、ルートの表のファイルを表す型である。 */
export type RouteFiles = Files<unknown, unknown, unknown>;

/** 実行時のルートの表で、各ファイルを読み込む関数を表す型である。 */
export type LoadedFiles = Files<
  Load<RouteComponent>,
  Load<MiddlewareHandler>,
  (() => Promise<Partial<Readonly<Record<RouteMethod, Handler>>>>) & { readonly file: string }
>;

/** エラーのページと、外側から順に列挙した、そのディレクトリのレイアウトを表す。 */
export interface Fallback<F extends RouteFiles = LoadedFiles> {
  readonly module: F["component"];
  readonly layouts: readonly F["component"][];
}

/** ページと `not-found.tsx` の行の、エラーのページを表す。 */
export interface Fallbacks<F extends RouteFiles = LoadedFiles> {
  /** そのディレクトリか祖先のディレクトリで最も近い `not-found.tsx` である。 */
  readonly notFound?: Fallback<F>;
  /** そのディレクトリか祖先のディレクトリで最も近い `error.tsx` である。 */
  readonly error?: Fallback<F>;
}

/** ルートの表の 1 行を表す。`layouts` と `middlewares` は、外側から順に列挙する。 */
export type Route<F extends RouteFiles = LoadedFiles> = {
  /** Hono のパスである。`not-found.tsx` の行では、そのディレクトリの配下のすべての URL に一致するパスである。 */
  readonly path: string;
  /** ルートのディレクトリ以外の `middleware.ts` である。 */
  readonly middlewares: readonly F["middleware"][];
} & (
  | ({
      readonly kind: "page";
      /** グループを除いたファイルの形のパス（`/users/[id]`）である。 */
      readonly pattern: string;
      readonly module: F["component"];
      readonly layouts: readonly F["component"][];
    } & Fallbacks<F>)
  | ({
      readonly kind: "not-found";
      /** この行の `not-found.tsx` と、そのディレクトリのレイアウトである。 */
      readonly notFound: Fallback<F>;
    } & Pick<Fallbacks<F>, "error">)
  | {
      readonly kind: "route";
      /** グループを除いたファイルの形のパス（`/api/users`）である。 */
      readonly pattern: string;
      readonly module: F["handlers"];
    }
);

/** ルートの表を表す。`middleware` は、ルートのディレクトリの `middleware.ts` である。 */
export interface Routes<F extends RouteFiles = LoadedFiles> {
  readonly routes: readonly Route<F>[];
  readonly middleware?: F["middleware"];
}

/** `routes` の各ファイルを、ファイルの種類ごとの関数 `map` で置き換えた表を返す。 */
export function mapRouteFiles<C, M, H, C2, M2, H2>(
  routes: Routes<Files<C, M, H>>,
  map: {
    readonly component: (file: C) => C2;
    readonly middleware: (file: M) => M2;
    readonly handlers: (file: H) => H2;
  },
): Routes<Files<C2, M2, H2>> {
  type From = Files<C, M, H>;
  type To = Files<C2, M2, H2>;
  const fallback = (page: Fallback<From>): Fallback<To> => ({
    ...page,
    module: map.component(page.module),
    layouts: page.layouts.map(map.component),
  });
  const optional = (page: Fallback<From> | undefined): Fallback<To> | undefined =>
    page === undefined ? undefined : fallback(page);
  const row = (route: Route<From>): Route<To> => {
    const middlewares = route.middlewares.map(map.middleware);
    switch (route.kind) {
      case "page":
        return {
          ...route,
          middlewares,
          module: map.component(route.module),
          layouts: route.layouts.map(map.component),
          notFound: optional(route.notFound),
          error: optional(route.error),
        };
      case "not-found":
        return {
          ...route,
          middlewares,
          notFound: fallback(route.notFound),
          error: optional(route.error),
        };
      case "route":
        return { ...route, middlewares, module: map.handlers(route.module) };
    }
  };
  return {
    ...routes,
    routes: routes.routes.map(row),
    middleware: routes.middleware === undefined ? undefined : map.middleware(routes.middleware),
  };
}

/** アプリの設定を表す。 */
export interface AppOptions {
  /** ページの `<head>` の末尾に出力するマークアップである。 */
  readonly head?: string;
  /** ページのレイアウトとページのファイルを外側から順に受け取り、ページの `<head>` の末尾に `<link rel="stylesheet">` として出力する CSS の URL を、出力する順に返す。 */
  readonly styles?: (files: readonly string[]) => Promise<readonly string[]>;
  /** ページとサーバー関数のエンドポイントが投げた、`HTTPException` 以外の、rinka が扱わないエラーを受け取り、アプリが返す Response を返す。 */
  readonly onError?: (error: unknown) => Response;
  /** GET 以外のサーバー関数のリクエストで、別のサイトからでも受け付ける `Origin` を列挙する。 */
  readonly trustedOrigins?: readonly string[];
  /** サーバー関数のリクエストごとに ID を受け取り、その ID のサーバー関数の定義を読み込めたら真を返す。偽を返した ID のリクエストには 404 を返す。 */
  readonly loadServerFn?: (id: string) => Promise<boolean>;
  /** `true` なら、パラメータのあるページのリクエストのパラメータが、そのページの `prerender` が返すパラメータに無いときに、`notFound()` と同じ 404 を返す。 */
  readonly prerendered?: true;
}

/** ルートの表から、各ページを描画するアプリを作成する関数を表す。 */
export type CreateApp = (
  routes: Routes,
  options?: AppOptions,
) => { readonly fetch: (request: Request) => Response | Promise<Response> };

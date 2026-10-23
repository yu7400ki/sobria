import type { Handler, MiddlewareHandler } from "hono";

/** ルートのファイルの種類を表す。 */
export type RouteKind = "page" | "route" | "not-found";

/** `route.ts` が export できる HTTP メソッドである。 */
export const routeMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** `route.ts` が export できる HTTP メソッドを表す。 */
export type RouteMethod = (typeof routeMethods)[number];

/** モジュールを読み込み、その default export を返す関数を表す。 */
export type Load<T> = () => Promise<{ readonly default: T }>;

/** ページ、レイアウト、エラーのページのコンポーネントを表す。 */
export type RouteComponent = (props: never) => unknown;

/** ルートの表が参照するファイルを、ファイルの種類ごとに表す型である。 */
export interface RouteFiles {
  readonly component: unknown;
  readonly middleware: unknown;
  readonly handlers: unknown;
}

/** 実行時のルートの表で、各ファイルを読み込む関数を表す型である。 */
export interface LoadedFiles extends RouteFiles {
  readonly component: Load<RouteComponent>;
  readonly middleware: Load<MiddlewareHandler>;
  readonly handlers: () => Promise<Partial<Readonly<Record<RouteMethod, Handler>>>>;
}

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
      readonly module: F["component"];
      readonly layouts: readonly F["component"][];
    } & Fallbacks<F>)
  | {
      readonly kind: "not-found";
      readonly module: F["component"];
      readonly layouts: readonly F["component"][];
      /** そのディレクトリか祖先のディレクトリで最も近い `error.tsx` である。 */
      readonly error?: Fallback<F>;
    }
  | { readonly kind: "route"; readonly module: F["handlers"] }
);

/** ルートの表を表す。`middleware` は、ルートのディレクトリの `middleware.ts` である。 */
export interface Routes<F extends RouteFiles = LoadedFiles> {
  readonly routes: readonly Route<F>[];
  readonly middleware?: F["middleware"];
}

/** `routes` の各ファイルを、ファイルの種類ごとの関数 `map` で置き換えた表を返す。 */
export function mapRouteFiles<F extends RouteFiles, G extends RouteFiles>(
  routes: Routes<F>,
  map: { readonly [K in keyof RouteFiles]: (file: F[K]) => G[K] },
): Routes<G> {
  const fallback = ({ module, layouts }: Fallback<F>): Fallback<G> => ({
    module: map.component(module),
    layouts: layouts.map(map.component),
  });
  const row = (route: Route<F>): Route<G> => {
    const common = { path: route.path, middlewares: route.middlewares.map(map.middleware) };
    switch (route.kind) {
      case "page":
        return {
          ...common,
          kind: route.kind,
          module: map.component(route.module),
          layouts: route.layouts.map(map.component),
          ...(route.notFound && { notFound: fallback(route.notFound) }),
          ...(route.error && { error: fallback(route.error) }),
        };
      case "not-found":
        return {
          ...common,
          kind: route.kind,
          module: map.component(route.module),
          layouts: route.layouts.map(map.component),
          ...(route.error && { error: fallback(route.error) }),
        };
      case "route":
        return { ...common, kind: route.kind, module: map.handlers(route.module) };
    }
  };
  return {
    routes: routes.routes.map(row),
    ...(routes.middleware !== undefined && { middleware: map.middleware(routes.middleware) }),
  };
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

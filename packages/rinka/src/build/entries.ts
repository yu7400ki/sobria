import type { UserConfig } from "vite";

/** rinka の入口の指定子である。`routes`、`app`、`styles`、`noElements` はプラグインが作成する仮想モジュールである。 */
export const entries = {
  main: "rinka",
  jsxRuntime: "rinka/jsx-runtime",
  internal: "rinka/internal",
  server: "rinka/server",
  routes: "rinka/routes",
  app: "rinka/app",
  styles: "rinka/styles",
  noElements: "rinka/no-elements",
  router: "rinka/router",
  tsconfig: "rinka/tsconfig.json",
} as const;

/** プラグインが生成するコードが、環境ごとに `rinka/internal` から import する名前である。 */
export const internalNames = {
  client: ["createSheet", "updateSheet", "loadSheet"],
  server: ["serverSheet", "createApp", "routeStyles", "serverFnLoader", "devErrorResponse"],
} as const;

/** `environment` の `rinka/internal` から `names` を import する文を返す。 */
export const importInternal = <E extends keyof typeof internalNames>(
  _environment: E,
  ...names: readonly (typeof internalNames)[E][number][]
): string => `import { ${names.join(", ")} } from "${entries.internal}";`;

/** プラグインが作成する仮想モジュールの指定子 `specifier` を、解決した ID にする。 */
export const virtualId = (specifier: string): string => `\0${specifier}`;

/** rinka のクライアントの実行時のコードが値として import する、rinka の外のモジュールである。 */
export const clientImports = ["@solidjs/signals", "seroval"] as const;

/** rinka のサーバーの実行時のコードが値として import する、rinka の外のモジュールである。 */
export const serverImports = [
  ...clientImports,
  "hono",
  "hono/combine",
  "hono/factory",
  "hono/http-exception",
] as const;

/** oxc の変換の設定である。`sourceType` は Vite の型に無い項目で、oxc の変換にはそのまま渡される。 */
export const oxc = {
  jsx: { runtime: "automatic", importSource: entries.main, development: false },
  sourceType: "module",
} satisfies UserConfig["oxc"] & { sourceType: "module" };

/** 環境ごとの実行時のコードの入口を、`lib/` からの相対パスで表す。 */
export const runtimes: Readonly<Record<"client" | "server", Readonly<Record<string, string>>>> = {
  client: {
    [entries.main]: "client/index.js",
    [entries.jsxRuntime]: "client/jsx-runtime.js",
    [entries.internal]: "client/internal.js",
  },
  server: {
    [entries.main]: "server/index.js",
    [entries.jsxRuntime]: "server/jsx-runtime.js",
    [entries.internal]: "server/internal.js",
  },
};

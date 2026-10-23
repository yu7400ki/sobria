import type { UserConfig } from "vite";

/** rinka の入口の指定子である。`routes`、`entry`、`serverIndex` はプラグインが作成する仮想モジュールである。 */
export const entries = {
  main: "rinka",
  jsxRuntime: "rinka/jsx-runtime",
  internal: "rinka/internal",
  server: "rinka/server",
  routes: "rinka/routes",
  entry: "rinka/entry",
  serverIndex: "rinka/server-index",
  static: "rinka/static",
  router: "rinka/router",
  tsconfig: "rinka/tsconfig.json",
} as const;

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
    [entries.static]: "server/static.js",
  },
};

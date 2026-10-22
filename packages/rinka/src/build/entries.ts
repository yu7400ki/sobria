import type { UserConfig } from "vite";

/** rinka の入口の指定子である。`routes` はプラグインが作成する仮想モジュールである。 */
export const entries = {
  main: "rinka",
  jsxRuntime: "rinka/jsx-runtime",
  internal: "rinka/internal",
  routes: "rinka/routes",
} as const;

/** oxc の変換の設定である。`sourceType` は Vite の型に無い項目で、oxc の変換にはそのまま渡される。 */
export const oxc = {
  jsx: { runtime: "automatic", importSource: entries.main, development: false },
  sourceType: "module",
} satisfies UserConfig["oxc"] & { sourceType: "module" };

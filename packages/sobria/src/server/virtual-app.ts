import type { Hono } from "hono";

/** ファイルベースのルーティングとサーバー関数から構築した、sobria のアプリである。 */
const app: Hono = (() => {
  throw new Error(
    "sobria/app は、sobria の Vite プラグインがビルドするモジュールです。vite.config.ts の plugins に sobria() を記述してください。",
  );
})();

export default app;

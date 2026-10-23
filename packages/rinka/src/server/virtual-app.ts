import type { Hono } from "hono";

/** ファイルベースのルーティングとサーバー関数から構築した、rinka のアプリである。 */
const app: Hono = (() => {
  throw new Error(
    "rinka/app は、rinka の Vite プラグインがビルドするモジュールです。vite.config.ts の plugins に rinka() を記述してください。",
  );
})();

export default app;

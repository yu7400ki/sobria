import { Hono } from "hono";

import { jsx } from "./jsx-runtime.ts";
import { renderToResponse } from "./render.ts";

/** ルートの表の 1 行を表す。`page` は、ページのモジュールを読み込む。 */
export interface Route {
  readonly path: string;
  readonly page: () => Promise<{ readonly default: (props: Record<string, never>) => unknown }>;
}

/** アプリの設定を表す。 */
export interface AppOptions {
  /** ページの `<head>` の末尾に出力するマークアップである。 */
  readonly head?: string;
}

/** ルートの表から、各ページを描画する Hono のアプリを作成する。 */
export function createApp(routes: readonly Route[], options: AppOptions = {}): Hono {
  const app = new Hono();
  for (const route of routes) {
    app.get(route.path, async () => {
      const { default: page } = await route.page();
      return renderToResponse(jsx(page, {}), {
        ...(options.head !== undefined && { head: options.head }),
      });
    });
  }
  return app;
}

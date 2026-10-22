import { Hono } from "hono";

import type { AppOptions, CreateApp, Route } from "../shared/routes.ts";
import { jsx } from "./jsx-runtime.ts";
import { renderDocument } from "./render.ts";

/** ルートの表から、各ページを描画する Hono のアプリを作成する。 */
export const createApp = ((routes: readonly Route[], options: AppOptions = {}): Hono => {
  const app = new Hono();
  const { onError } = options;
  if (onError) app.onError((c) => onError(c.error));
  for (const route of routes) {
    app.get(route.path, async () => {
      const { default: page } = await route.page();
      return renderDocument(jsx(page, {}), {
        ...(options.head !== undefined && { head: options.head }),
      });
    });
  }
  return app;
}) satisfies CreateApp;

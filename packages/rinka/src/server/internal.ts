import { Hono } from "hono";

import {
  createElementComponent,
  type Ctx,
  type Delivery,
  type ElementComponent,
  type ElementOptions,
} from "../shared/element.ts";
import type { AppOptions, CreateApp, Route } from "../shared/routes.ts";
import { runInRequest } from "./context.ts";
import { jsx } from "./jsx-runtime.ts";
import { renderDocument } from "./render.ts";

/** `fn` を、`tag` の名前の要素として、ブラウザが読み込むモジュールの URL とデフォルトの起動タイミングとともに登録する。 */
export function defineElement<P, M extends object = object>(
  tag: string,
  fn: (props: P, ctx: Ctx<M>) => unknown,
  options: ElementOptions,
  delivery: Delivery,
): ElementComponent<P, M> {
  return createElementComponent(tag, fn, options, delivery);
}

/** ルートの表から、各ページを描画する Hono のアプリを作成する。 */
export const createApp = ((routes: readonly Route[], options: AppOptions = {}): Hono => {
  const app = new Hono();
  const { onError } = options;
  if (onError) app.onError((c) => onError(c.error));
  for (const route of routes) {
    app.get(route.path, (c) =>
      runInRequest(c, async () => {
        const { default: page } = await route.page();
        return renderDocument(jsx(page, {}), {
          ...(options.head !== undefined && { head: options.head }),
        });
      }),
    );
  }
  return app;
}) satisfies CreateApp;

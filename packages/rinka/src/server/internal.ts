import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import {
  createElementComponent,
  type Ctx,
  type Delivery,
  type ElementComponent,
  type ElementOptions,
} from "../shared/element.ts";
import type { AppOptions, CreateApp, Route } from "../shared/routes.ts";
import { runInRequest } from "./context.ts";
import { serverFnMiddleware } from "./endpoint.ts";
import { jsx } from "./jsx-runtime.ts";
import { renderDocument } from "./render.ts";

export { registerServerFn } from "./endpoint.ts";

/** `fn` を、`tag` の名前の要素として、ブラウザが読み込むモジュールの URL とデフォルトの起動タイミングとともに登録する。 */
export function defineElement<P, M extends object = object>(
  tag: string,
  fn: (props: P, ctx: Ctx<M>) => unknown,
  options: ElementOptions,
  delivery: Delivery,
): ElementComponent<P, M> {
  return createElementComponent(tag, fn, options, delivery);
}

/** Hono のデフォルトのエラーの処理と同じく、`HTTPException` はそのレスポンスにし、それ以外は記録して素のテキストの 500 にする。 */
function defaultFailure(error: unknown): Response {
  if (error instanceof HTTPException) return error.getResponse();
  console.error(error);
  return new Response("Internal Server Error", { status: 500 });
}

/** ルートの表から、各ページを描画する Hono のアプリを作成する。 */
export const createApp = ((routes: readonly Route[], options: AppOptions = {}): Hono => {
  const app = new Hono();
  const fail = options.onError ?? defaultFailure;
  app.onError((c) => fail(c.error));
  const serverFns = serverFnMiddleware(options, fail);
  app.use((c, next) => runInRequest(c, () => serverFns(c, next)));
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

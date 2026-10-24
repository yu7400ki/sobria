import {
  createElementComponent,
  type Ctx,
  type Delivery,
  type ElementComponent,
  type ElementOptions,
} from "../shared/element.ts";

export { createApp } from "./app.ts";
export { devErrorResponse } from "./dev-error.ts";
export { registerServerFn, serverFnLoader, serverFnModule } from "./endpoint.ts";
export { prerenderTargets } from "./prerender.ts";
export { routeStyles, serverSheet } from "./styles.ts";

/** `fn` を、`tag` の名前の要素として、ブラウザが読み込むモジュールの URL とデフォルトの起動タイミングとともに登録する。 */
export function defineElement<P, M extends object = object>(
  tag: string,
  fn: (props: P, ctx: Ctx<M>) => unknown,
  options: ElementOptions,
  delivery: Delivery,
): ElementComponent<P, M> {
  return createElementComponent(tag, fn, options, delivery);
}

import {
  createElementComponent,
  type Ctx,
  type ElementComponent,
  type ElementOptions,
} from "../shared/element.ts";

/** `fn` を、`tag` の名前の要素として、サーバーで描画できるようにする。 */
export function defineElement<P, M extends object = object>(
  tag: string,
  fn: (props: P, ctx: Ctx<M>) => unknown,
  options: ElementOptions,
): ElementComponent<P, M> {
  return createElementComponent(tag, fn, options);
}

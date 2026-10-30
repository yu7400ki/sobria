import type { SharedNode } from "./nodes.ts";

/** `createContext` が返すコンテキストを表す。`<Theme value={…}>` のように記述すると、子孫の `useContext(Theme)` は `value` を返す。 */
export interface SharedContext<T> {
  (props: { readonly value: T; readonly children?: unknown }): SharedNode;
}

/** ページか要素のインスタンスの描画の範囲で、コンテキストの値と、`createId` が作成した id の数を表す。 */
export interface RenderScope {
  readonly values: ReadonlyMap<SharedContext<never>, unknown>;
  readonly ids: { next: number };
}

/** コンテキストの値の無い、新しい描画の範囲を返す。 */
export const createRenderScope = (): RenderScope => ({ values: new Map(), ids: { next: 0 } });

/** 描画の範囲 `scope` に、コンテキスト `context` の値 `value` を加えた範囲を返す。id の数は `scope` と共有する。 */
export const provide = <T>(
  scope: RenderScope,
  context: SharedContext<T>,
  value: T,
): RenderScope => ({
  values: new Map(scope.values).set(context, value),
  ids: scope.ids,
});

/** コンテキストごとに、`createContext` に渡した値を保持する。 */
const defaults = new WeakMap<SharedContext<never>, unknown>();

/** `context` を、`useContext` が値の無い位置で `defaultValue` を返すコンテキストにして返す。 */
export function withDefault<T>(context: SharedContext<T>, defaultValue: T): SharedContext<T> {
  defaults.set(context, defaultValue);
  return context;
}

/** 描画の範囲 `scope` で、コンテキスト `context` の値を返す。値が無ければ、`createContext` に渡した値を返す。 */
export const valueOf = <T>(scope: RenderScope, context: SharedContext<T>): T =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  (scope.values.has(context) ? scope.values.get(context) : defaults.get(context)) as T;

/** 描画の範囲 `scope` で、新しい id を返す。 */
export const nextId = (scope: RenderScope): string => `sobria-i${++scope.ids.next}`;

/** 描画の範囲の外で `name` を呼んだときのエラーを返す。 */
export const outsideRender = (name: string): Error =>
  new Error(`${name} は、ページか要素の描画の中で呼び出してください。`);

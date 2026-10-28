import {
  createContext as createOwnerContext,
  createOwner,
  getContext,
  getOwner,
  runWithOwner,
  setContext,
  type Owner,
} from "@solidjs/signals";

import type { SharedNode } from "../shared/nodes.ts";
import { isFunction } from "../shared/objects.ts";
import {
  createRenderScope,
  nextId,
  outsideRender,
  provide,
  valueOf,
  withDefault,
  type RenderScope,
  type SharedContext,
} from "../shared/shared-context.ts";

/** owner に、その位置の描画の範囲を保持するコンテキストである。 */
const ScopeContext = createOwnerContext<RenderScope | null>(null);

/** 現在の owner に、コンテキストの値の無い新しい描画の範囲を設定する。 */
export function enterRenderScope(): void {
  setContext(ScopeContext, createRenderScope());
}

/** 現在の owner の描画の範囲を返す。描画の外では、`error` が返すエラーを投げる。 */
function currentScope(error: () => Error): RenderScope {
  const scope = getOwner() ? getContext(ScopeContext) : null;
  if (scope === null) throw error();
  return scope;
}

/** 子の値 `value` のうち、挿入するときに呼ぶ関数を、配列の中のものも含めて、`owner` の下で呼ぶ関数に置換して返す。 */
function withOwner(owner: Owner, value: unknown): unknown {
  if (isFunction(value)) return () => runWithOwner(owner, value);
  return Array.isArray(value) ? value.map((child) => withOwner(owner, child)) : value;
}

/** コンテキストを作成する。`<Theme value={…}>` の子孫の `useContext(Theme)` は `value` を返し、子孫でない位置では `defaultValue` を返す。 */
export function createContext<T>(defaultValue: T): SharedContext<T> {
  const context: SharedContext<T> = (props) => {
    const outer = currentScope(
      () => new Error("コンテキストのコンポーネントは、要素の描画の中に記述してください。"),
    );
    const scope = provide(outer, context, props.value);
    const owner = createOwner();
    const children = runWithOwner(owner, () => {
      setContext(ScopeContext, scope);
      return props.children;
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return withOwner(owner, children) as SharedNode;
  };
  return withDefault(context, defaultValue);
}

/** 描画の位置から見て最も内側の `context` の値を返す。無ければ `createContext` に渡した値を返す。 */
export const useContext = <T>(context: SharedContext<T>): T =>
  valueOf(
    currentScope(() => outsideRender("useContext")),
    context,
  );

/** ページか要素のインスタンスの中で一意な id を返す。 */
export const createId = (): string => nextId(currentScope(() => outsideRender("createId")));

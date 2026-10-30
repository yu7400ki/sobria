import {
  nextId,
  outsideRender,
  provide,
  valueOf,
  withDefault,
  type RenderScope,
  type SharedContext,
} from "../shared/shared-context.ts";
import { createStorage, type Storage } from "./context.ts";
import { asSharedNode, type ContextNode } from "./tree.ts";

let storage: Storage<RenderScope> | undefined;
let loading: Promise<Storage<RenderScope>> | undefined;

/** `runInScope` が描画の範囲を設定できる状態にする。 */
export async function prepareRenderScopes(): Promise<void> {
  storage ??= await (loading ??= createStorage());
}

/** `fn` を、描画の範囲 `scope` の中で実行する。`prepareRenderScopes` が完了した後に呼ぶ。 */
export function runInScope<T>(scope: RenderScope, fn: () => T): T {
  if (storage === undefined) throw new Error("[sobria] prepareRenderScopes が完了していません。");
  return storage.getStore() === scope ? fn() : storage.run(scope, fn);
}

/** 実行中の描画の範囲を返す。描画の外では、`error` が返すエラーを投げる。 */
function currentScope(error: () => Error): RenderScope {
  const scope = storage?.getStore();
  if (scope === undefined) throw error();
  return scope;
}

/** コンテキストを作成する。`<Theme value={…}>` の子孫の `useContext(Theme)` は `value` を返し、子孫でない位置では `defaultValue` を返す。 */
export function createContext<T>(defaultValue: T): SharedContext<T> {
  const context: SharedContext<T> = (props) => {
    const scope = provide(
      currentScope(
        () =>
          new Error("コンテキストのコンポーネントは、ページか要素の描画の中に記述してください。"),
      ),
      context,
      props.value,
    );
    const node: ContextNode = {
      kind: "context",
      scope,
      children: runInScope(scope, () => props.children),
    };
    return asSharedNode(node);
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

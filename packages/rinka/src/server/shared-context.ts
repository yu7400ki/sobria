import type { SharedNode } from "../shared/nodes.ts";
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
import type { ContextNode } from "./tree.ts";

let storage: Storage<RenderScope> | undefined;
let loading: Promise<Storage<RenderScope>> | undefined;

/** `runInScope` が描画の範囲を設定できる状態にする。 */
export async function prepareRenderScopes(): Promise<void> {
  storage ??= await (loading ??= createStorage());
}

/** `fn` を、描画の範囲 `scope` の中で実行する。`prepareRenderScopes` の前は、範囲を設定せずに実行する。 */
export const runInScope = <T>(scope: RenderScope, fn: () => T): T =>
  storage ? storage.run(scope, fn) : fn();

/** 実行中の描画の範囲を返す。描画の外では、`name` を呼んだことを示すエラーを投げる。 */
function currentScope(name: string): RenderScope {
  const scope = storage?.getStore();
  if (scope === undefined) throw outsideRender(name);
  return scope;
}

/** コンテキストを作成する。`<Theme value={…}>` の子孫の `useContext(Theme)` は `value` を返し、子孫でない位置では `defaultValue` を返す。 */
export function createContext<T>(defaultValue: T): SharedContext<T> {
  const context: SharedContext<T> = (props) => {
    const { value } = props;
    const node: ContextNode = {
      kind: "context",
      scope: (outer) => provide(outer, context, value),
      children: props.children,
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return node as unknown as SharedNode;
  };
  return withDefault(context, defaultValue);
}

/** 描画の位置から見て最も内側の `context` の値を返す。無ければ `createContext` に渡した値を返す。 */
export const useContext = <T>(context: SharedContext<T>): T =>
  valueOf(currentScope("useContext"), context);

/** ページか要素のインスタンスの中で一意な id を返す。 */
export const createId = (): string => nextId(currentScope("createId"));

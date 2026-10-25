declare const client: unique symbol;
declare const server: unique symbol;
declare const slot: unique symbol;

/** 要素のファイルの JSX を評価した値の型を表す。実行時の値は、DOM のノードである。 */
export interface ClientNode {
  readonly [client]: true;
}

/** サーバーのファイルの JSX を評価した値の型を表す。実行時の値は、HTML を出力する描画の単位である。 */
export interface ServerNode {
  readonly [server]: true;
}

/** サーバーのファイルの JSX のランタイムが作成した、タグとコンポーネントのノードを記録する集合である。 */
export const serverJsxNodes = new WeakSet<object>();

/** 要素の Props で、スロットになる props の型を表す。 */
export interface Slot {
  readonly [slot]: true;
}

/** スロットに渡せる内容を表す。要素とサーバーコンポーネントのどちらで記述した内容も受け付ける。 */
export type SlotContent =
  | ClientNode
  | ServerNode
  | string
  | number
  | boolean
  | null
  | undefined
  | SlotContent[];

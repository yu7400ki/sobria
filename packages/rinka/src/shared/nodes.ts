declare const client: unique symbol;
declare const server: unique symbol;

/** 要素のファイルの JSX を評価した値の型。実行時の値は、DOM のノードである。 */
export interface ClientNode {
  readonly [client]: true;
}

/** サーバーのファイルの JSX を評価した値の型。実行時の値は、HTML を出力する描画の単位である。 */
export interface ServerNode {
  readonly [server]: true;
}

/** スロットに渡せる内容。要素とサーバーコンポーネントのどちらで記述した内容も受け付ける。 */
export type Slot = ClientNode | ServerNode | string | number | boolean | null | undefined | Slot[];

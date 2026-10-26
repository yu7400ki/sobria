import type { DefaultLoad } from "./element.ts";
import type { CallOptions, ServerFnMethod } from "./server-fn.ts";

/**
 * 1 つの境界の中身と、その境界の中の差し替えを表す。`b` は境界の ID で、`bp` は境界の目印を含む Shadow DOM のホストの ID の列である。
 * `p` の各要素は、差し替えの ID と、その差し替えの目印を含む Shadow DOM のホストの ID の列の組である。
 */
export interface SwapSpec {
  readonly b: string;
  readonly bp: readonly string[];
  readonly p: readonly (readonly [id: string, path: readonly string[]])[];
}

/** 起動スクリプトに伝える要素を、タグ名、モジュールの URL、デフォルトの起動タイミングの組で表す。 */
export type ListedElement = readonly [tag: string, module: string, load: DefaultLoad];

/** ストリームの状態の値である。`open` は値が届く途中、`done` は終わった状態、`failed` は失敗した状態である。 */
export const streamState = { open: 0, done: 1, failed: 2 } as const;

/** ストリームの状態を表す。 */
export type StreamState = (typeof streamState)[keyof typeof streamState];

/** サーバーが反復している async iterable の、最新の値と状態を表す。 */
export interface TransferStream {
  /** 最新の値である。 */
  v: unknown;
  /** 値が届くたびに 1 増加する。 */
  n: number;
  /** ストリームの状態である。 */
  d: StreamState;
  /** 値か状態が変化したときに 1 回だけ呼ぶ関数を保持する。 */
  readonly l: (() => void)[];
}

/** 起動スクリプトが `window.$rinka` に定義する受け口を表す。 */
export interface Receiver {
  /** ホストの ID ごとに、引き継ぐ値をキーごとに保持する。 */
  readonly v: Record<string, Record<string, unknown> | undefined>;
  /** ホストの ID ごとに、値が届いたときに呼ぶ関数を保持する。 */
  readonly l: Record<string, (() => void)[] | undefined>;
  /** 値が無いことを表すオブジェクトである。 */
  readonly n: object;
  /** `s` で作成したストリームを保持する。 */
  readonly t: WeakSet<TransferStream>;
  /** 最初の値が `value` のストリームを作成する。 */
  readonly s: (value: unknown) => TransferStream;
  /** ホストの `key` のストリームに、`state` が `0` なら値 `value` を追加し、それ以外なら状態を `state` にする。 */
  readonly p: (id: string, key: string, state: StreamState, value?: unknown) => void;
  /** ホストに引き継ぐ値を保持して、そのホストで値を待っている関数に通知する。 */
  readonly d: (id: string, values: Record<string, unknown>) => void;
  /** 1 つの境界の中身と、その境界の中の差し替えを適用する。開始と終了の目印がそろわない差し替えは、適用せずに除去する。 */
  readonly r: (spec: SwapSpec) => void;
  /** 要素の一覧を保持し、各要素の最初のインスタンスが起動の条件を満たした時点で、モジュールを 1 回だけ読み込む。 */
  readonly m: (list: readonly ListedElement[]) => void;
  /** 同じ ID とメソッドには、ID とメソッドを保持する同じ関数を返す。返す関数は、呼ばれるたびに `c` から RPC の関数を取得して呼ぶ。 */
  readonly f: (id: string, method: ServerFnMethod) => RpcCall;
  /** ID とメソッドから、RPC で呼び出す関数を返す。クライアントのランタイムが登録する。 */
  c?: (id: string, method: ServerFnMethod) => RpcCall;
  /** インスタンスの起動のタイミングの属性か、一覧のデフォルトの起動タイミングの条件を満たした時点で `start` を呼ぶ。一覧に無いタグなら、すぐに呼ぶ。 */
  readonly w: (host: Element, start: () => void) => void;
}

/** RPC でサーバー関数を呼び出す関数である。 */
type RpcCall = (input?: unknown, options?: CallOptions) => Promise<unknown>;

/** 起動スクリプトが `window.$rinka` に定義する受け口の名前を列挙する。 */
export const receiverKeys = [
  "v",
  "l",
  "n",
  "t",
  "s",
  "p",
  "d",
  "r",
  "m",
  "f",
  "c",
  "w",
] as const satisfies readonly (keyof Receiver)[];

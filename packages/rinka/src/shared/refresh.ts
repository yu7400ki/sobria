import type { ListedElement } from "./receiver.ts";
import type { PROPS_KEY, REFRESH_PROPS_KEY } from "./transfer-keys.ts";

/** `refreshPage()` が描き直しを要求するリクエストに付けるヘッダーの名前である。値は `1` である。 */
export const REFRESH_HEADER = "x-rinka-refresh";

/** `refreshPage()` のレスポンスの JSON を表す。 */
export interface RefreshJson {
  readonly head: string;
  readonly body: string;
  /** ホストの ID ごとの、`@r` と `@p` の props を持つオブジェクトの JS の式である。 */
  readonly data: Readonly<Record<string, string>>;
  readonly elements: readonly ListedElement[];
  readonly doc: {
    readonly html: Readonly<Record<string, string>>;
    readonly body: Readonly<Record<string, string>>;
  };
}

/** 描き直しのレスポンスの `data` の式を評価した値で、1 つのホストの props を持つ。 */
export interface RefreshValues {
  /** ページにある要素に設定する props である。 */
  readonly [REFRESH_PROPS_KEY]: object;
  /** 新しく現れた要素が起動時に受け取る、属性にできない props である。 */
  readonly [PROPS_KEY]?: unknown;
}

/** 現在のページをサーバーで描き直して、ページに反映する関数を表す。 */
export type RefreshPage = () => Promise<void>;

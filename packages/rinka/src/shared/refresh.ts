import type { ListedElement } from "./receiver.ts";

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
    readonly html: Readonly<Record<string, string | null>>;
    readonly body: Readonly<Record<string, string | null>>;
  };
}

/** 現在のページをサーバーで描き直して、ページに反映する関数を表す。 */
export type RefreshPage = () => Promise<void>;

import type { ListedElement } from "./receiver.ts";
import type { PROPS_KEY, REFRESH_PROPS_KEY } from "./transfer-keys.ts";

/** ページの描き直しを要求するリクエストに付けるヘッダーの名前である。値は `1` である。 */
export const REFRESH_HEADER = "x-rinka-refresh";

/** JS からサーバー関数を呼び出したリクエストで、呼び出したページの URL を値に持つヘッダーの名前である。 */
export const PAGE_HEADER = "x-rinka-page";

/** `a` と `b` が、hash を除いて同じ URL かどうかを返す。 */
export const sameDocument = (a: URL, b: URL): boolean => withoutHash(a) === withoutHash(b);

/** hash を除いた `url` の文字列を返す。 */
function withoutHash(url: URL): string {
  const copy = new URL(url);
  copy.hash = "";
  return copy.href;
}

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
  /** 新しく現れた要素が起動時に受け取る、属性の文字列から元の値に戻せない props である。 */
  readonly [PROPS_KEY]?: unknown;
}

/** 現在のページをサーバーで描き直して、ページに反映する関数を表す。 */
export type RefreshPage = () => Promise<void>;

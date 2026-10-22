import type { Effect } from "../shared/signals.ts";

/** サーバーで描画している間は、`read` と `apply` を呼ばずに戻る。 */
export const effect: Effect = () => {};

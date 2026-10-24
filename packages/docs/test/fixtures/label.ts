import { jsx } from "rinka/jsx-runtime";

/** 見本の MDX が ESM で import する値である。 */
export const label = "注";

/** 見本の MDX が JSX の属性に展開するオブジェクトである。 */
export const rest = { "data-kind": "note" };

/** props をすべて `<aside>` に渡して描画する。見本の MDX が JSX で使用するコンポーネントである。 */
export const Note = (props: Record<string, unknown>): unknown => jsx("aside", props);

import { signal, type Ctx } from "rinka";
import { css } from "styled-system/css";

import sheet from "../styles.css" with { type: "css" };

type Props = { code: string };

/** ボタンの通常のラベルである。 */
const LABEL = "コードをコピー";

/** コピーの結果をラベルに表示する時間（ミリ秒）である。 */
const RESULT_DURATION = 2000;

/** 押すと、`code` をクリップボードにコピーするボタンである。 */
export default function CopyButton(props: Props, ctx: Ctx) {
  ctx.css(sheet);
  const [label, setLabel] = signal(LABEL);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.code);
      setLabel("コピーしました");
    } catch {
      setLabel("ブラウザがコピーを拒否しました");
    }
    setTimeout(() => setLabel(LABEL), RESULT_DURATION);
  };
  return (
    <button
      type="button"
      onClick={copy}
      class={css({
        px: "2",
        py: "1",
        fontSize: "xs",
        color: "muted.foreground",
        bg: "background",
        borderWidth: "1px",
        borderColor: "border",
        rounded: "sm",
        cursor: "pointer",
        _hover: { color: "foreground" },
      })}
    >
      {label()}
    </button>
  );
}

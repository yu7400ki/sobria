import type { ServerNode } from "rinka";
import { css } from "styled-system/css";

import CopyButton from "../../elements/copy-button.tsx";

/** MDX のコードブロックを描画する。`children` は色付けした `<pre>` である。 */
export default function CodeBlock(props: { code: string; lang?: string; children?: ServerNode }) {
  return (
    <div
      data-lang={props.lang}
      class={css({
        pos: "relative",
        bg: "muted",
        rounded: "md",
        fontSize: "sm",
        "& pre": { p: "4", overflowX: "auto", lineHeight: "1.7" },
      })}
    >
      {props.children}
      <CopyButton code={props.code} class={css({ pos: "absolute", top: "2", right: "2" })} />
    </div>
  );
}

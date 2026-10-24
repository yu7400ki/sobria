import type { Slot } from "rinka";
import { css } from "styled-system/css";

/** MDX のコードブロックを描画する。`children` は色付けした `<pre>` である。 */
export default function CodeBlock(props: { code: string; lang?: string; children?: Slot }) {
  return (
    <div class={css({ bg: "muted", rounded: "md" })} data-lang={props.lang}>
      {props.children}
    </div>
  );
}

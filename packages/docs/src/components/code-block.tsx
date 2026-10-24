import type { Slot } from "rinka";

/** MDX のコードブロックを描画する。`children` は色付けした `<pre>` である。 */
export default function CodeBlock(props: { code: string; lang?: string; children?: Slot }) {
  return <div data-lang={props.lang}>{props.children}</div>;
}

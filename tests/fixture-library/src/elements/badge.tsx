import type { Ctx } from "rinka";

import sheet from "../styles/badge.css" with { type: "css" };

type Props = {
  /** バッジに表示する文字列である。 */
  label: string;
  children?: JSX.Element;
};

/**
 * ラベルとスロットの内容を表示する。
 * @cssprop --badge-color - 文字の色である。
 */
export default function Badge(props: Props, { css, host, onMount }: Ctx) {
  css(sheet);
  onMount(() => host.setAttribute("data-started", ""));
  return (
    <span class="badge" part="badge">
      {props.label}
      {props.children}
    </span>
  );
}

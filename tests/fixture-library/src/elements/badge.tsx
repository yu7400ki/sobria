import type { Ctx } from "rinka";

import sheet from "../styles/badge.css" with { type: "css" };

type Props = { label: string; children?: JSX.Element };

export default function Badge(props: Props, { css, host, onMount }: Ctx) {
  css(sheet);
  onMount(() => host.setAttribute("data-started", ""));
  return (
    <span class="badge">
      {props.label}
      {props.children}
    </span>
  );
}

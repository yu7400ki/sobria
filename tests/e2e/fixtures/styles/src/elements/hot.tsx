import type { Ctx } from "sobria";

import sheet from "../styles/hot.css" with { type: "css" };

export default function Hot(_props: {}, { css, host, onMount }: Ctx) {
  css(sheet);
  onMount(() => host.setAttribute("data-started", ""));
  return <p class="hot">hot</p>;
}

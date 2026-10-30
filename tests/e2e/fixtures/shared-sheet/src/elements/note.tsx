import type { Ctx } from "sobria";

import sheet from "../styles/app.css" with { type: "css" };

export default function Note(_props: {}, { css, host, onMount }: Ctx) {
  css(sheet);
  onMount(() => host.setAttribute("data-started", ""));
  return <p class="note">note</p>;
}

import type { Ctx } from "sobria";

import sheet from "../styles/card.css" with { type: "css" };

export default function Card(_props: {}, { css, host, onMount }: Ctx) {
  css(sheet);
  onMount(() => host.setAttribute("data-started", ""));
  return <p class="card">card</p>;
}

import type { Ctx } from "rinka";

import tw from "../styles/app.css" with { type: "css" };

export default function Badge(_props: {}, { css, host, onMount }: Ctx) {
  css(tw);
  onMount(() => host.setAttribute("data-started", ""));
  return <span class="block rotate-3 p-2 shadow-lg">badge</span>;
}

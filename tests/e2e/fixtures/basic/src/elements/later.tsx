import type { Ctx } from "sobria";

export default function Later(_props: {}, ctx: Ctx) {
  ctx.onMount(() => ctx.host.setAttribute("data-started", ""));
  return <p>later</p>;
}

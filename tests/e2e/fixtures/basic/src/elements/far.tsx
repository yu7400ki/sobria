import type { Ctx } from "rinka";

export default function Far(_props: {}, ctx: Ctx) {
  ctx.onMount(() => ctx.host.setAttribute("data-started", ""));
  return <p>far</p>;
}

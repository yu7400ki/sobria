import type { Ctx } from "rinka";

export default function Wide(_props: {}, ctx: Ctx) {
  ctx.onMount(() => ctx.host.setAttribute("data-started", ""));
  return <p>wide</p>;
}

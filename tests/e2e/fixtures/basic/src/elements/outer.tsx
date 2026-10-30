import type { Ctx } from "sobria";

import Inner from "./inner.tsx";

export default function Outer(_props: {}, ctx: Ctx) {
  ctx.onMount(() => ctx.host.setAttribute("data-started", ""));
  return (
    <section>
      <Inner start={3} />
    </section>
  );
}

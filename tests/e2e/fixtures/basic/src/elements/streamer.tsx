import { memo, type Ctx } from "rinka";

import { letters } from "../lib/letters.ts";

export default function Streamer(_props: {}, ctx: Ctx) {
  const letter = memo(() => letters());
  ctx.onMount(() => ctx.host.setAttribute("data-started", ""));
  return <p>{letter()}</p>;
}

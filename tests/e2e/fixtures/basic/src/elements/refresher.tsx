import { refreshPage, signal, type Ctx } from "rinka";

import { save } from "../lib/fns.ts";

type Props = { label: string };

export default function Refresher(props: Props, ctx: Ctx) {
  const [clicks, setClicks] = signal(0);
  ctx.onMount(() => ctx.host.setAttribute("data-started", ""));
  return (
    <div>
      <button id="count" onClick={() => setClicks(clicks() + 1)}>
        {props.label} {clicks()}
      </button>
      <button id="refresh" onClick={() => void refreshPage()}>
        refresh
      </button>
      <button id="save" onClick={() => void save()}>
        save
      </button>
    </div>
  );
}

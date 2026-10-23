import { signal, type Ctx } from "rinka";

import { ping } from "../lib/fns.ts";

type Props = { ping: () => Promise<string> };

export default function Pinger(props: Props, ctx: Ctx) {
  const [result, setResult] = signal("");
  const call = async () => setResult((await Promise.all([props.ping(), ping()])).join(" "));
  ctx.onMount(() => ctx.host.setAttribute("data-started", ""));
  return <button onClick={() => void call()}>{result()}</button>;
}

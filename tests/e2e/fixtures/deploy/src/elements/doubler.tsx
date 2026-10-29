import { memo, type Ctx } from "rinka";

export default function Doubler(props: { base: number }, { host, onMount }: Ctx) {
  const doubled = memo(async () => {
    await Promise.resolve();
    return props.base * 2;
  });
  onMount(() => host.setAttribute("data-started", ""));
  return <p class="doubled">{doubled()}</p>;
}

import { signal, type Ctx } from "sobria";

import { ping } from "../lib/fns.ts";

import sheet from "../styles/counter.css" with { type: "css" };

export default function Counter(props: { start: number }, { css, host, onMount }: Ctx) {
  css(sheet);
  const [count, setCount] = signal(props.start);
  const [reply, setReply] = signal("");
  onMount(() => host.setAttribute("data-started", ""));
  return (
    <section>
      <button class="count" onClick={() => setCount(count() + 1)}>
        {count()}
      </button>
      <button class="ping" onClick={async () => setReply(await ping())}>
        {reply()}
      </button>
    </section>
  );
}

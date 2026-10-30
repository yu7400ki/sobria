import { signal, type Ctx } from "sobria";
import { href } from "sobria/router";

import Card from "../components/card.tsx";
import { greet } from "../lib/greet.ts";

import sheet from "../styles/counter.css" with { type: "css" };

type Props = { start: number; header?: JSX.Element; children?: JSX.Element };

export default function Counter(props: Props, { css, expose }: Ctx<{ reset(): void }>) {
  css(sheet);
  const [count, setCount] = signal(props.start);
  const [message, setMessage] = signal("");
  expose({ reset: () => setCount(props.start) });
  return (
    <section>
      <header>{props.header}</header>
      <Card title="counter" />
      <button class="count" onClick={() => setCount(count() + 1)}>
        {count()}
      </button>
      <button onClick={async () => setMessage(await greet())}>{message()}</button>
      <a href={href("/users/[id]", { id: count() })}>user</a>
      {props.children}
    </section>
  );
}

document.querySelector("app-counter")?.reset();
document.createElement("app-counter").start = 1;

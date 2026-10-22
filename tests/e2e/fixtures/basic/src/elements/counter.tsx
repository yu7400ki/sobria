import { memo, signal } from "rinka";

type Props = { start: number; label?: string; children?: JSX.Element };

export default function Counter(props: Props) {
  const [count, setCount] = signal(props.start);
  const doubled = memo(async () => {
    await Promise.resolve();
    return props.start * 2;
  });
  return (
    <section>
      <button onClick={() => setCount(count() + 1)}>
        {props.label ?? "count"}: {count()}
      </button>
      <p>{doubled()}</p>
      <div>{props.children}</div>
    </section>
  );
}

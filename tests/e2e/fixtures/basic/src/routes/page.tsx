import Counter from "../elements/counter.tsx";

export default function Page() {
  return (
    <main>
      <h1>basic</h1>
      <Counter start={2} label="clicks">
        body
      </Counter>
    </main>
  );
}

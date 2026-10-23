import Counter from "../elements/counter.tsx";
import { save } from "../lib/fns.ts";

export default function Page() {
  return (
    <>
      <h1>deploy</h1>
      <Counter start={2} />
      <form action={save}>
        <input name="title" />
      </form>
    </>
  );
}

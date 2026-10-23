import Badge from "../elements/badge.tsx";
import Counter from "../elements/counter.tsx";
import { save } from "../lib/fns.ts";

export default function Page() {
  return (
    <>
      <h1>deploy</h1>
      <Counter start={2} />
      <Badge label="new" />
      <form action={save}>
        <input name="title" />
      </form>
    </>
  );
}

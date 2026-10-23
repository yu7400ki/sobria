import Pinger from "../../elements/pinger.tsx";
import { ping, save } from "../../lib/fns.ts";

export default function Page() {
  return (
    <main>
      <Pinger ping={ping} />
      <form action={save}>
        <input name="title" />
      </form>
    </main>
  );
}

import Refresher from "../../elements/refresher.tsx";
import { addNote, failNote, notes } from "../../lib/notes.ts";

export default function Page() {
  return (
    <main>
      <ul id="notes">
        {notes.map((note) => (
          <li>{note}</li>
        ))}
      </ul>
      <Refresher label="notes" />
      <form action={addNote}>
        <input name="title" />
        <button id="add">add</button>
      </form>
      <form action={failNote}>
        <button id="fail">fail</button>
      </form>
    </main>
  );
}

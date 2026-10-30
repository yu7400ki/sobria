import Badge from "@sobria-tests/fixture-library/badge";

import Note from "../elements/badge.tsx";

export default function Page() {
  return (
    <main>
      <h1>library app</h1>
      <Badge label="new">
        <b>slotted</b>
      </Badge>
      <Note text="note" />
    </main>
  );
}

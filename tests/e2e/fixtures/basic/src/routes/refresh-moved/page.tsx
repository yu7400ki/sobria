import { redirect } from "sobria/server";

import Refresher from "../../elements/refresher.tsx";

let renders = 0;

export default function Page() {
  renders += 1;
  if (renders > 1) throw redirect("/refresh");
  return (
    <main>
      <Refresher label="moved" />
    </main>
  );
}

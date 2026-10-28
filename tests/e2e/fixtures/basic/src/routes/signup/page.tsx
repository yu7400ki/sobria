import { getServerFnResult } from "rinka/server";

import Refresher from "../../elements/refresher.tsx";
import { signup } from "../../lib/signup.ts";

export default function Page() {
  const result = getServerFnResult(signup);
  return (
    <main>
      <Refresher label="signup" />
      <form action={signup}>
        <input name="name" value={result?.values.name ?? ""} />
        {result && <p id="error">{result.error}</p>}
        <button id="signup">signup</button>
      </form>
    </main>
  );
}

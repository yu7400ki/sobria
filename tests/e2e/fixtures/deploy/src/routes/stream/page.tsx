import { Loading } from "sobria";

import Doubler from "../../elements/doubler.tsx";

async function Late() {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return (
    <>
      <p class="late">late</p>
      <Doubler base={3} />
    </>
  );
}

export default function Stream() {
  return (
    <>
      <Doubler base={2} />
      <Loading fallback={<p class="waiting">waiting</p>}>
        <Late />
      </Loading>
    </>
  );
}

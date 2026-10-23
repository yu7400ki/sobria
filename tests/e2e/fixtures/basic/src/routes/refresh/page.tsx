import Refresher from "../../elements/refresher.tsx";

let renders = 0;

export default function Page() {
  renders += 1;
  return (
    <main>
      <title>{`refresh ${renders}`}</title>
      <p id="renders">{renders}</p>
      <Refresher label={`v${renders}`} />
    </main>
  );
}

import Far from "../../elements/far.tsx";
import Later from "../../elements/later.tsx";
import Wide from "../../elements/wide.tsx";

export default function Page() {
  return (
    <main>
      <Later load:idle />
      <Wide load:media="(min-width: 600px)" />
      <div style="margin-top: 2000px">
        <Far load:visible />
      </div>
    </main>
  );
}

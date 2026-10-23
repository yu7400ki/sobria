import Card from "../components/card.tsx";
import Counter from "../elements/counter.tsx";

export default function Page() {
  return (
    <>
      <Card title="home" />
      <Counter start={1} header={<p>header</p>} load:visible>
        body
      </Counter>
    </>
  );
}

import { Loading } from "rinka";

export const prerender = true;

async function Late() {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return <p>late</p>;
}

export default function About() {
  return (
    <>
      <h1>about</h1>
      <Loading fallback={<p>waiting</p>}>
        <Late />
      </Loading>
    </>
  );
}

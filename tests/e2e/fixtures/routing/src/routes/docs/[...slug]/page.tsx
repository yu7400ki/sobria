import type { PageProps } from "sobria/router";

export default function Doc({ params }: PageProps<"/docs/[...slug]">) {
  return <p>doc {params.slug}</p>;
}

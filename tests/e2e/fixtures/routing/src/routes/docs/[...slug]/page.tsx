import type { PageProps } from "rinka/router";

export default function Doc({ params }: PageProps<"/docs/[...slug]">) {
  return <p>doc {params.slug}</p>;
}

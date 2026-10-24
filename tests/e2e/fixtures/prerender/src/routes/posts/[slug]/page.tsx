import type { PageProps } from "rinka/router";

export const prerender = () => [{ slug: "hello" }, { slug: "a b" }];

export default function Post({ params }: PageProps<"/posts/[slug]">) {
  return <h1>post {params.slug}</h1>;
}

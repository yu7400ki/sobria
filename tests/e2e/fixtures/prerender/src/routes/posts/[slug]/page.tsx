import type { PageProps } from "sobria/router";

export const prerender = () => [{ slug: "hello" }, { slug: "a b" }, { slug: "日本" }];

export default function Post({ params }: PageProps<"/posts/[slug]">) {
  return <h1>post {params.slug}</h1>;
}

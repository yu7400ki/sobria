import type { PageProps } from "sobria/router";

export default function NotFound({ url }: Pick<PageProps<"/">, "url">) {
  return <h1>root not found {url.pathname}</h1>;
}

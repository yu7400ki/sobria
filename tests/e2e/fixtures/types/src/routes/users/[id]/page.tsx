import type { PageProps } from "sobria/router";

export default function User(props: PageProps<"/users/[id]">) {
  return <p>{props.params.id}</p>;
}

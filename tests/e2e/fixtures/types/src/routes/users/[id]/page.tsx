import type { PageProps } from "rinka/router";

export default function User(props: PageProps<"/users/[id]">) {
  return <p>{props.params.id}</p>;
}

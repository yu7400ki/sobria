import { href } from "sobria/router";

export default function UserLink(props: { userId: number }) {
  return <a href={href("/users/[id]", { id: props.userId })}>user {props.userId}</a>;
}

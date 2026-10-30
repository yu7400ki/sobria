import { href } from "sobria/router";

import UserLink from "../elements/user-link.tsx";

export default function Home() {
  return (
    <main>
      <h1>home</h1>
      <a href={href("/users/[id]", { id: 1 })}>first</a>
      <UserLink userId={2} />
    </main>
  );
}

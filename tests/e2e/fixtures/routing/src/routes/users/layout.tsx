import type { LayoutProps } from "sobria/router";

export default function UsersLayout({ children }: LayoutProps) {
  return <section id="users">{children}</section>;
}

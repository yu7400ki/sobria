import type { LayoutProps } from "rinka/router";

export default function UsersLayout({ children }: LayoutProps) {
  return <section id="users">{children}</section>;
}

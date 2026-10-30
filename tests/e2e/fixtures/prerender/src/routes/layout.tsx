import type { LayoutProps } from "sobria/router";

export default function Layout(props: LayoutProps) {
  return <main>{props.children}</main>;
}

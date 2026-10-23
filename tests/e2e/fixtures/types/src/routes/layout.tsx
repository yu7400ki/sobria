import type { LayoutProps } from "rinka/router";

export default function Layout(props: LayoutProps) {
  return <main>{props.children}</main>;
}

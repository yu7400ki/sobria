import type { LayoutProps } from "rinka/router";

import "../styles/app.css";

export default function Layout(props: LayoutProps) {
  return <main>{props.children}</main>;
}

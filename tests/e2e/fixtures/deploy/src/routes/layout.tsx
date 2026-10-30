import type { LayoutProps } from "sobria/router";

import "../styles/app.css";

export default function Layout(props: LayoutProps) {
  return <main>{props.children}</main>;
}

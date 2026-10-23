import { theme } from "../lib/theme.ts";

import "../styles/global.css";

export const layoutTheme = theme;

export default function Layout(props: { children?: unknown }) {
  return props.children;
}

import type { LayoutProps } from "sobria/router";

export default function RootLayout({ children }: LayoutProps) {
  return <div id="root">{children}</div>;
}

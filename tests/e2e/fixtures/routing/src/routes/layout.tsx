import type { LayoutProps } from "rinka/router";

export default function RootLayout({ children }: LayoutProps) {
  return <div id="root">{children}</div>;
}

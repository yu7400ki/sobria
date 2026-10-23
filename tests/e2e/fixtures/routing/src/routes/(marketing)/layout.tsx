import type { LayoutProps } from "rinka/router";

export default function MarketingLayout({ children }: LayoutProps) {
  return <article id="marketing">{children}</article>;
}

import type { LayoutProps } from "sobria/router";

export default function MarketingLayout({ children }: LayoutProps) {
  return <article id="marketing">{children}</article>;
}

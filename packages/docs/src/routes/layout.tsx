import "../styles.css";
import type { LayoutProps } from "rinka/router";

export default function Layout(props: LayoutProps) {
  return (
    <html lang="ja">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>{props.children}</body>
    </html>
  );
}

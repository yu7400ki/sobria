import "../styles.css";
import { href, type LayoutProps } from "rinka/router";

import Header from "../components/header.tsx";
import { firstSlug } from "../lib/content.ts";

export default function Layout(props: LayoutProps) {
  return (
    <html lang="ja">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>rinka</title>
      </head>
      <body>
        <Header docsHref={href("/[...slug]", { slug: firstSlug })} />
        {props.children}
      </body>
    </html>
  );
}

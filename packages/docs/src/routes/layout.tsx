import "../styles.css";
import { href, type LayoutProps } from "sobria/router";

import Header from "../components/header.tsx";
import { firstPage } from "./content.ts";

export default function Layout(props: LayoutProps) {
  return (
    <html lang="ja">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>sobria</title>
      </head>
      <body>
        <Header homeHref={href("/")} docsHref={firstPage.href} />
        {props.children}
      </body>
    </html>
  );
}

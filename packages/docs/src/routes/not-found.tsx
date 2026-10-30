import { href } from "sobria/router";
import { css } from "styled-system/css";

export default function NotFound() {
  return (
    <main class={css({ maxW: "3xl", mx: "auto", px: "6", py: "24", textAlign: "center" })}>
      <title>ページが見つかりません | sobria</title>
      <h1 class={css({ fontSize: "3xl", fontWeight: "bold" })}>ページが見つかりません</h1>
      <a
        href={href("/")}
        class={css({
          display: "inline-block",
          mt: "8",
          color: "accent",
          textDecoration: "underline",
        })}
      >
        トップページに戻る
      </a>
    </main>
  );
}

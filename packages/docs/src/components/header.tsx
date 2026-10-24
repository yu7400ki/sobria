import { css } from "styled-system/css";

/** サイトの上部のナビゲーションを描画する。`docsHref` は、ドキュメントの最初のページの URL である。 */
export default function Header(props: { docsHref: string }) {
  return (
    <header
      class={css({
        display: "flex",
        alignItems: "center",
        gap: "6",
        h: "14",
        px: "6",
        borderBottomWidth: "1px",
        borderColor: "border",
      })}
    >
      <a href="/" class={css({ fontWeight: "semibold", fontSize: "lg" })}>
        rinka
      </a>
      <nav>
        <a
          href={props.docsHref}
          class={css({ color: "muted.foreground", _hover: { color: "foreground" } })}
        >
          ドキュメント
        </a>
      </nav>
    </header>
  );
}

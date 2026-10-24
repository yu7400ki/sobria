import { css } from "styled-system/css";

/** 前後のページへのリンクである。 */
interface PagerLink {
  readonly href: string;
  readonly title: string;
}

/** 前のページ `prev` と次のページ `next` へのリンクを描画する。 */
export default function Pager(props: { prev?: PagerLink; next?: PagerLink }) {
  const link = css({
    display: "block",
    p: "3",
    borderWidth: "1px",
    borderColor: "border",
    rounded: "md",
    _hover: { borderColor: "accent" },
  });
  const label = css({ display: "block", fontSize: "xs", color: "muted.foreground" });
  return (
    <nav class={css({ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4", mt: "12" })}>
      <div>
        {props.prev && (
          <a href={props.prev.href} class={link}>
            <span class={label}>前のページ</span>
            {props.prev.title}
          </a>
        )}
      </div>
      <div class={css({ textAlign: "right" })}>
        {props.next && (
          <a href={props.next.href} class={link}>
            <span class={label}>次のページ</span>
            {props.next.title}
          </a>
        )}
      </div>
    </nav>
  );
}

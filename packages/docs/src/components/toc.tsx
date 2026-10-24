import { css } from "styled-system/css";

import type { TocItem } from "../lib/content.ts";

/** ページ内の見出しへのリンクを列挙する。深さ 3 の見出しは字下げする。 */
export default function Toc(props: { items: readonly TocItem[] }) {
  return (
    <nav class={css({ fontSize: "xs" })}>
      <p class={css({ mb: "2", color: "muted.foreground" })}>このページ</p>
      <ul>
        {props.items.map((item) => (
          <li class={css({ pl: item.depth === 3 ? "3" : "0" })}>
            <a
              href={`#${item.id}`}
              class={css({
                display: "block",
                py: "1",
                color: "muted.foreground",
                _hover: { color: "accent" },
              })}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

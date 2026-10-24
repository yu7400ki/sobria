import { css } from "styled-system/css";

/** サイドバーの区分である。 */
export interface SidebarSection {
  readonly title: string;
  readonly links: readonly {
    readonly href: string;
    readonly title: string;
    readonly current: boolean;
  }[];
}

/** 区分ごとに、本文へのリンクを列挙する。表示しているページのリンクを強調する。 */
export default function Sidebar(props: { sections: readonly SidebarSection[] }) {
  return (
    <nav class={css({ fontSize: "sm" })}>
      {props.sections.map((section) => (
        <div class={css({ mb: "6" })}>
          <p class={css({ mb: "2", fontSize: "xs", color: "muted.foreground" })}>{section.title}</p>
          <ul>
            {section.links.map((link) => (
              <li>
                <a
                  href={link.href}
                  aria-current={link.current ? "page" : undefined}
                  class={css({
                    display: "block",
                    mx: "-2",
                    px: "2",
                    py: "1",
                    rounded: "sm",
                    color: "muted.foreground",
                    _hover: { color: "foreground" },
                    "&[aria-current=page]": { bg: "accent.subtle", color: "accent.emphasis" },
                  })}
                >
                  {link.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

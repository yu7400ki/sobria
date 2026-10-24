import { css } from "styled-system/css";

/** サイドバーの区分である。 */
interface SidebarSection {
  readonly title: string;
  readonly pages: readonly { readonly href: string; readonly title: string }[];
}

/** 区分ごとに、本文へのリンクを列挙する。URL が `currentHref` のページのリンクを強調する。 */
export default function Sidebar(props: {
  sections: readonly SidebarSection[];
  currentHref: string;
}) {
  return (
    <nav class={css({ fontSize: "sm" })}>
      {props.sections.map((section) => (
        <div class={css({ mb: "6" })}>
          <p class={css({ mb: "2", fontSize: "xs", color: "muted.foreground" })}>{section.title}</p>
          <ul>
            {section.pages.map((link) => (
              <li>
                <a
                  href={link.href}
                  aria-current={link.href === props.currentHref ? "page" : undefined}
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

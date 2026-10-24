import { href } from "rinka/router";
import { css } from "styled-system/css";

import { firstSlug } from "../lib/content.ts";

/** トップページで紹介する、rinka の特徴である。 */
const features = [
  { title: "ページ", text: "サーバーコンポーネントとして描画し、JS を送信しません。" },
  { title: "要素", text: "Custom Element を Declarative Shadow DOM で SSR します。" },
  { title: "更新", text: "Signal で、変わった箇所だけを更新します。" },
];

export default function Home() {
  return (
    <>
      <html>
        <body class="dark" />
      </html>
      <main class={css({ maxW: "5xl", mx: "auto", px: "6", py: "24", textAlign: "center" })}>
        <h1 class={css({ fontSize: "5xl", fontWeight: "bold" })}>rinka</h1>
        <p class={css({ mt: "4", fontSize: "lg", color: "muted.foreground" })}>
          Hono と Vite の上で動作する、サーバーファーストの Web フレームワーク
        </p>
        <div class={css({ display: "flex", justifyContent: "center", gap: "3", mt: "8" })}>
          <a
            href={href("/[...slug]", { slug: firstSlug })}
            class={css({
              px: "5",
              py: "2",
              rounded: "md",
              bg: "accent",
              color: "accent.foreground",
              fontWeight: "medium",
            })}
          >
            ドキュメントを読む
          </a>
        </div>
        <ul
          class={css({
            display: "grid",
            gridTemplateColumns: { base: "1fr", md: "repeat(3, 1fr)" },
            gap: "4",
            mt: "20",
            textAlign: "left",
          })}
        >
          {features.map((feature) => (
            <li class={css({ p: "5", borderWidth: "1px", borderColor: "border", rounded: "lg" })}>
              <p class={css({ color: "accent.emphasis", fontWeight: "medium" })}>{feature.title}</p>
              <p class={css({ mt: "2", fontSize: "sm", color: "muted.foreground" })}>
                {feature.text}
              </p>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}

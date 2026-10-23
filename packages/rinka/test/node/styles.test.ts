import { describe, expect, it } from "vitest";

import { defineElement } from "../../src/server/element.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToString } from "../../src/server/render.ts";
import type { Ctx } from "../../src/shared/element.ts";
import { sheetInfo } from "../../src/shared/styles.ts";

/** サーバーで `css` に渡す、`href` の CSS を表すシートを返す。 */
const sheet = (href: string) =>
  ({ [sheetInfo]: { href, properties: "" } }) as unknown as CSSStyleSheet;

/** 連続する空白を 1 つの空白にする。 */
const squash = (html: string) => html.replaceAll(/\s+/g, " ");

describe("SSR の ctx の css", () => {
  it('タグ付きテンプレートを <style> に、シートを <link rel="stylesheet"> に、呼び出した順に DSD の先頭に出力する', async () => {
    const Card = defineElement(
      "x-styled-card",
      (_props: object, { css }: Ctx) => {
        css`
          :host {
            display: block;
          }
        `;
        css(sheet("/src/app.css?direct"));
        css`
          p {
            margin: ${4}px;
          }
        `;
        return jsx("p", { children: "x" });
      },
      { props: [] },
    );
    expect(squash(await renderToString(jsx(Card, {})))).toContain(
      '<template shadowrootmode="open"><style> :host { display: block; } </style><link rel="stylesheet" href="/src/app.css?direct"><style> p { margin: 4px; } </style><p>x</p></template>',
    );
  });

  it("<style> の中の </style は <\\/style に置換する", async () => {
    const Card = defineElement(
      "x-styled-escape",
      (_props: object, { css }: Ctx) => {
        css`
          a::after {
            content: "${"</style></STYLE><script>"}";
          }
        `;
        return null;
      },
      { props: [] },
    );
    expect(squash(await renderToString(jsx(Card, {})))).toContain(
      '<style> a::after { content: "<\\/style><\\/STYLE><script>"; } </style>',
    );
  });

  it("with { type: 'css' } で import していないシートを css に渡すと、エラーを送出する", async () => {
    const Card = defineElement(
      "x-styled-plain",
      (_props: object, { css }: Ctx) => {
        css({} as CSSStyleSheet);
        return null;
      },
      { props: [] },
    );
    await expect(renderToString(jsx(Card, {}))).rejects.toThrow("with { type: 'css' }");
  });
});

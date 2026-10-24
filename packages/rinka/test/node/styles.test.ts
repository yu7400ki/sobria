import { describe, expect, it } from "vitest";

import { Errored, Loading } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToResponse, renderToString } from "../../src/server/response.ts";
import { serverSheet } from "../../src/server/styles.ts";
import type { Ctx } from "../../src/shared/element.ts";

/** サーバーで `css` に渡す、`href` の CSS を表すシートを返す。`properties` は CSS に含まれる `@property` の規則である。 */
const sheet = (href: string, properties = "") =>
  serverSheet(href, properties) as unknown as CSSStyleSheet;

/** `node` を描画した文書の HTML を返す。 */
const document = async (node: unknown) => (await renderToResponse(node)).text();

/** `ms` ミリ秒後に `node` を返すコンポーネントを返す。 */
const after = (ms: number, node: unknown) => async () => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return node;
};

/** `rule` の規則を持つシートを使用する、タグが `tag` の要素を返す。 */
const ruled = (tag: string, rule: string) =>
  defineElement(
    tag,
    (_props: object, { css }: Ctx) => {
      css(sheet(`/src/${tag}.css?direct`, rule));
      return null;
    },
    { props: [] },
  );

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

describe("@property の規則", () => {
  it("シェルで使用したシートの @property の規則を、シートごとに 1 回だけ <head> の <style data-rinka-properties> に出力する", async () => {
    const rule = '@property --gap { syntax: "<length>"; inherits: false; initial-value: 7px; }';
    const gap = sheet("/src/gap.css?direct", rule);
    const plain = sheet("/src/plain.css?direct");
    const Gap = defineElement(
      "x-styled-gap",
      (_props: object, { css }: Ctx) => {
        css(gap);
        css(plain);
        return null;
      },
      { props: [] },
    );
    const html = await document(jsx("main", { children: [jsx(Gap, {}), jsx(Gap, {})] }));
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain(`<style data-rinka-properties>${rule}</style>`);
    expect(html.split(rule)).toHaveLength(2);
  });

  it("@property の規則を持つシートを使用しなければ、<style data-rinka-properties> を出力しない", async () => {
    expect(await document(jsx("main", {}))).not.toContain("data-rinka-properties");
  });
});

describe("後送りの内容の @property の規則", () => {
  it("後送りの内容で初めて使用したシートの規則を、その内容の先頭の <style data-rinka-properties> に出力し、シェルで出力した規則は繰り返さない", async () => {
    const shellRule = '@property --a { syntax: "*"; inherits: false; }';
    const lateRule = '@property --b { syntax: "*"; inherits: false; }';
    const Shell = defineElement(
      "x-styled-shell",
      (_props: object, { css }: Ctx) => {
        css(sheet("/src/a.css?direct", shellRule));
        return null;
      },
      { props: [] },
    );
    const Late = defineElement(
      "x-styled-late",
      (_props: object, { css }: Ctx) => {
        css(sheet("/src/a.css?direct", shellRule));
        css(sheet("/src/b.css?direct", lateRule));
        return null;
      },
      { props: [] },
    );
    const Slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsx(Late, {});
    };
    const html = await document(
      jsx("main", {
        children: [jsx(Shell, {}), jsx(Loading, { fallback: "wait", children: jsx(Slow, {}) })],
      }),
    );
    expect(html.split(shellRule)).toHaveLength(2);
    expect(html).toContain(`<style data-rinka-properties>${lateRule}</style><x-styled-late`);
  });

  it("後送りの境界で使用したシートの規則は、先に出力したほかの境界の内容に出力しない", async () => {
    const rule = '@property --rb { syntax: "*"; inherits: false; }';
    const Early = defineElement("x-styled-early", () => null, { props: [] });
    const Ruled = ruled("x-styled-ruled", rule);
    const html = await document(
      jsx("main", {
        children: [
          jsx(Loading, { fallback: "a", children: jsx(after(40, jsx(Early, {})), {}) }),
          jsx(Loading, {
            fallback: "b",
            children: [jsx(after(10, jsx(Ruled, {})), {}), jsx(after(80, "done"), {})],
          }),
        ],
      }),
    );
    expect(html.indexOf(rule)).toBeGreaterThan(html.indexOf("<x-styled-early"));
    expect(html).toContain(`<style data-rinka-properties>${rule}</style><x-styled-ruled`);
  });

  it("シェルより先に描画を終えた後送りの境界の規則は、<head> に出力せず、その境界の内容の先頭に出力する", async () => {
    const rule = '@property --pre { syntax: "*"; inherits: false; }';
    const Ruled = ruled("x-styled-pre", rule);
    const html = await document(
      jsx("main", {
        children: [
          jsx(Loading, { fallback: "wait", children: jsx(after(5, jsx(Ruled, {})), {}) }),
          jsx(after(40, "shell"), {}),
        ],
      }),
    );
    expect(html.indexOf(rule)).toBeGreaterThan(html.indexOf("</head>"));
    expect(html).toContain(`<style data-rinka-properties>${rule}</style><x-styled-pre`);
  });
});

/** 失敗するコンポーネントである。 */
const Fail = async () => {
  throw new Error("失敗");
};

describe("<Errored> の中の要素の @property の規則", () => {
  it("成功した <Errored> の中の要素が使用したシートの規則を、<head> に出力する", async () => {
    const rule = '@property --kept { syntax: "*"; inherits: false; }';
    const Kept = ruled("x-styled-kept", rule);
    const html = await document(
      jsx("main", { children: jsx(Errored, { fallback: "fb", children: jsx(Kept, {}) }) }),
    );
    expect(html).toContain(`<style data-rinka-properties>${rule}</style></head>`);
  });

  it("後送りの境界の中で成功した <Errored> の中の要素が使用したシートの規則を、境界の内容の先頭に出力する", async () => {
    const rule = '@property --kept-late { syntax: "*"; inherits: false; }';
    const Kept = ruled("x-styled-kept-late", rule);
    const html = await document(
      jsx("main", {
        children: jsx(Loading, {
          fallback: "wait",
          children: jsx(after(5, jsx(Errored, { fallback: "fb", children: jsx(Kept, {}) })), {}),
        }),
      }),
    );
    expect(html).toContain(`<style data-rinka-properties>${rule}</style><x-styled-kept-late`);
  });
});

describe("出力しなかった内容の @property の規則", () => {
  it("失敗した <Errored> の中の要素が使用したシートの規則は出力しない", async () => {
    const rule = '@property --lost { syntax: "*"; inherits: false; }';
    const Lost = ruled("x-styled-lost", rule);
    const html = await document(
      jsx("main", {
        children: jsx(Errored, { fallback: "fb", children: [jsx(Lost, {}), jsx(Fail, {})] }),
      }),
    );
    expect(html).toContain("fb");
    expect(html).not.toContain("--lost");
  });
});

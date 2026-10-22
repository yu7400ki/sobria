import { describe, expect, it } from "vitest";

import { Errored, Loading } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { Fragment, jsx } from "../../src/server/jsx-runtime.ts";
import { renderToString } from "../../src/server/render.ts";
import { memo } from "../../src/shared/signals.ts";

describe("ネイティブのタグ", () => {
  it("テキストと属性の値をエスケープする", async () => {
    expect(await renderToString(jsx("p", { title: 'a"<b&', children: "<x>&" }))).toBe(
      '<p title="a&quot;<b&amp;">&lt;x&gt;&amp;</p>',
    );
  });

  it("空要素は終了タグを出力しない", async () => {
    expect(await renderToString(jsx("input", { value: "v", disabled: true }))).toBe(
      '<input value="v" disabled>',
    );
  });

  it("属性の出力の規則に従い、key を data-ok にし、onX の関数と ref を出力しない", async () => {
    const html = await renderToString(
      jsx(
        "div",
        {
          hidden: false,
          "aria-checked": false,
          class: { a: true, b: false },
          onClick: () => {},
          ref: () => {},
          alt: "",
          title: "",
        },
        "k",
      ),
    );
    expect(html).toBe('<div aria-checked="false" class="a" alt="" title="" data-ok="k"></div>');
  });

  it("関数で渡した子と属性は、呼び出した値を出力する", async () => {
    expect(await renderToString(jsx("p", { title: () => "t", children: () => ["a", 1] }))).toBe(
      '<p title="t">a1</p>',
    );
  });
});

const Item = (props: { label: string }) => jsx("li", { children: props.label });

const SlowBold = async () => {
  await Promise.resolve();
  return jsx("b", { children: "done" });
};

const SlowText = async () => {
  await Promise.resolve();
  return "done";
};

const Sync = () => {
  throw new Error("sync");
};

const Async = async () => {
  await Promise.resolve();
  throw new Error("async");
};

const fallback = (error: unknown) => `failed: ${(error as Error).message}`;

describe("コンポーネント", () => {
  it("コンポーネントと Fragment は、返した内容を出力する", async () => {
    const html = await renderToString(
      jsx("ul", {
        children: jsx(Fragment, {
          children: [jsx(Item, { label: "a" }), jsx(Item, { label: "b" })],
        }),
      }),
    );
    expect(html).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("async のコンポーネントは、解決した内容を出力する", async () => {
    expect(await renderToString(jsx("p", { children: jsx(SlowBold, {}) }))).toBe(
      "<p><b>done</b></p>",
    );
  });

  it("Errored は、同期的に投げられたエラーと、async のコンポーネントの失敗を受け止める", async () => {
    const html = await renderToString([
      jsx(Errored, { fallback, children: jsx(Sync, {}) }),
      jsx(Errored, { fallback, children: jsx(Async, {}) }),
    ]);
    expect(html).toBe("failed: syncfailed: async");
  });

  it("Loading の中身が解決すれば、フォールバックを出力せずに中身を出力する", async () => {
    expect(
      await renderToString(jsx(Loading, { fallback: "wait", children: jsx(SlowText, {}) })),
    ).toBe("done");
  });
});

type CardProps = {
  label?: string;
  count?: number;
  data?: object;
  header?: unknown;
  children?: unknown;
};

const Card = defineElement(
  "x-card",
  (props: CardProps) => jsx("p", { children: () => props.label }),
  { props: ["label", "count", "data", "header", "children"], slots: ["header"] },
);

describe("要素の SSR", () => {
  it("Shadow DOM の中身を DSD として出力し、ホストに data-oh、プリミティブの props とホストの属性を出力する", async () => {
    const html = await renderToString(jsx(Card, { label: "hi", count: 2, id: "c" }));
    expect(html).toBe(
      '<x-card data-oh="h1" label="hi" count="2" id="c"><template shadowrootmode="open"><p>hi</p></template></x-card>',
    );
  });

  it("属性にできない props があれば、data-om に @p を列挙する", async () => {
    const html = await renderToString(jsx(Card, { data: { a: 1 } }));
    expect(html).toBe(
      '<x-card data-oh="h1" data-om="@p"><template shadowrootmode="open"><p></p></template></x-card>',
    );
  });

  it("シリアライズできない props は、位置を含むエラーにする", async () => {
    await expect(renderToString(jsx(Card, { data: { f: () => {} } }))).rejects.toThrow(
      "<x-card> data.f は関数なので",
    );
  });

  it("Light DOM の子は DSD の後に出力し、名前付きのスロットの要素に slot 属性を付与し、テキストを span で包む", async () => {
    const html = await renderToString(
      jsx(Card, {
        header: ["見出し", jsx("h1", { children: "a" })],
        children: jsx("p", { children: "本文" }),
      }),
    );
    expect(html).toBe(
      '<x-card data-oh="h1"><template shadowrootmode="open"><p></p></template><span slot="header">見出し</span><h1 slot="header">a</h1><p>本文</p></x-card>',
    );
  });

  it("要素の中の非同期の memo は、解決した値を出力する", async () => {
    const User = defineElement(
      "x-user",
      () => {
        const name = memo(() => Promise.resolve("ann"));
        return jsx("b", { title: () => name(), children: () => name() });
      },
      { props: [] },
    );
    expect(await renderToString(jsx(User, {}))).toBe(
      '<x-user data-oh="h1"><template shadowrootmode="open"><b title="ann">ann</b></template></x-user>',
    );
  });

  it("要素の中の要素は、それぞれの ID のホストとして出力する", async () => {
    const Outer = defineElement("x-outer", () => jsx(Card, { label: "in" }), { props: [] });
    expect(await renderToString(jsx(Outer, {}))).toBe(
      '<x-outer data-oh="h1"><template shadowrootmode="open"><x-card data-oh="h2" label="in"><template shadowrootmode="open"><p>in</p></template></x-card></template></x-outer>',
    );
  });
});

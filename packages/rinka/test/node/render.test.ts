import { afterEach, describe, expect, it, vi } from "vitest";

import { Errored, Loading } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { Fragment, jsx } from "../../src/server/jsx-runtime.ts";
import { renderToResponse, renderToString } from "../../src/server/response.ts";
import { memo } from "../../src/shared/signals.ts";

/** `props` の `<option>` を作成する。 */
const option = (props: Record<string, unknown>) => jsx("option", props);

describe("ネイティブのタグ", () => {
  it("テキストと属性の値をエスケープする", async () => {
    expect(await renderToString(jsx("p", { title: 'a"<b&', children: "<x>&" }))).toBe(
      '<p title="a&quot;&lt;b&amp;">&lt;x&gt;&amp;</p>',
    );
  });

  it("属性の値の < と > をエスケープするので、<noscript> の中の属性の値で </noscript> を閉じられない", async () => {
    const html = await renderToString(
      jsx("noscript", {
        children: jsx("img", { alt: "</noscript><img src=x onerror=alert(1)>", src: "/a.png" }),
      }),
    );
    expect(html).toBe(
      '<noscript><img alt="&lt;/noscript&gt;&lt;img src=x onerror=alert(1)&gt;" src="/a.png"></noscript>',
    );
  });

  it("bigint の子はテキストにする", async () => {
    expect(await renderToString(jsx("p", { children: [1n, "a", 2n] }))).toBe("<p>1a2</p>");
  });

  it("<textarea> の value は、属性にせずに、開始タグの直後の改行の後にテキストの子として出力する", async () => {
    expect(await renderToString(jsx("textarea", { name: "t", value: "\na<b" }))).toBe(
      '<textarea name="t">\n\na&lt;b</textarea>',
    );
  });

  it("<select> の value は、属性にせずに、value かテキストが一致する <option> に selected を付ける", async () => {
    expect(
      await renderToString(
        jsx("select", {
          value: () => "b c",
          children: [
            option({ value: "a", children: "A" }),
            option({ children: () => " b\n c " }),
            jsx("select", { children: option({ value: "b c" }) }),
          ],
        }),
      ),
    ).toBe(
      '<select><option value="a">A</option><option selected> b\n c </option><select><option value="b c"></option></select></select>',
    );
    expect(
      await renderToString(
        jsx("select", {
          value: "1 件",
          children: [
            option({ children: [1, " 件"] }),
            option({ value: undefined, children: "1 件" }),
          ],
        }),
      ),
    ).toBe("<select><option selected>1 件</option><option selected>1 件</option></select>");
  });

  it("Object のプロトタイプにある名前の props も、属性として出力する", async () => {
    expect(
      await renderToString(jsx("input", { constructor: "c", toString: "t", hasOwnProperty: "h" })),
    ).toBe('<input constructor="c" toString="t" hasOwnProperty="h">');
    expect(await renderToString(jsx("constructor", { name: "n" }))).toBe(
      '<constructor name="n"></constructor>',
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
  {
    props: {
      label: "unknown",
      count: "number",
      data: "unknown",
      header: "slot",
      children: "slot",
    },
  },
);

describe("要素の SSR", () => {
  it("Shadow DOM の中身を DSD として出力し、ホストに data-oh、プリミティブの props とホストの属性を出力する", async () => {
    const html = await renderToString(jsx(Card, { label: "hi", count: 2, id: "c" }));
    expect(html).toBe(
      '<x-card data-oh="h1" label="hi" count="2" id="c"><template shadowrootmode="open"><!--[--><p><!--[-->hi<!--]--></p><!--]--></template></x-card>',
    );
  });

  it("Shadow DOM の中の <Errored> がフォールバックを出力したら、領域の先頭に目印を出力する", async () => {
    const Failing = defineElement(
      "x-failing",
      () =>
        jsx(Errored, {
          fallback: () => jsx("b", { children: "failed" }),
          children: () => {
            throw new Error("boom");
          },
        }),
      { props: {} },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await renderToString(jsx(Failing, {}))).toBe(
      '<x-failing data-oh="h1"><template shadowrootmode="open"><!--[--><!--[--><!--!--><b>failed</b><!--]--><!--]--></template></x-failing>',
    );
  });

  it("属性にできない props があれば、data-om に @p を列挙する", async () => {
    const html = await renderToString(jsx(Card, { data: { a: 1 } }));
    expect(html).toBe(
      '<x-card data-oh="h1" data-om="@p"><template shadowrootmode="open"><!--[--><p><!--[--><!--]--></p><!--]--></template></x-card>',
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
      '<x-card data-oh="h1"><template shadowrootmode="open"><!--[--><p><!--[--><!--]--></p><!--]--></template><span slot="header">見出し</span><h1 slot="header">a</h1><p>本文</p></x-card>',
    );
  });

  it("要素の中の非同期の memo は、解決した値を出力する", async () => {
    const User = defineElement(
      "x-user",
      () => {
        const name = memo(() => Promise.resolve("ann"));
        return jsx("b", { title: () => name(), children: () => name() });
      },
      { props: {} },
    );
    expect(await renderToString(jsx(User, {}))).toBe(
      '<x-user data-oh="h1"><template shadowrootmode="open"><!--[--><b title="ann"><!--[-->ann<!--]--></b><!--]--></template></x-user>',
    );
  });

  it("要素の中の要素は、それぞれの ID のホストとして出力する", async () => {
    const Outer = defineElement("x-outer", () => jsx(Card, { label: "in" }), { props: {} });
    expect(await renderToString(jsx(Outer, {}))).toBe(
      '<x-outer data-oh="h1"><template shadowrootmode="open"><!--[--><x-card data-oh="h2" label="in"><template shadowrootmode="open"><!--[--><p><!--[-->in<!--]--></p><!--]--></template></x-card><!--]--></template></x-outer>',
    );
  });
});

describe("要素の props とホストの属性", () => {
  const Sale = defineElement(
    "x-sale",
    (props: { onSale?: boolean; onPick?: () => void; label?: string }) =>
      jsx("p", {
        children: () => `${props.onSale ? "sale" : "normal"} ${typeof props.onPick} ${props.label}`,
      }),
    { props: { onSale: "unknown", onPick: "function", label: "unknown" } },
  );

  it("ホストに渡した onX の関数は、呼び出さずに出力しない", async () => {
    let called = 0;
    const html = await renderToString(jsx(Card, { onClick: () => called++ }));
    expect(called).toBe(0);
    expect(html).toBe(
      '<x-card data-oh="h1"><template shadowrootmode="open"><!--[--><p><!--[--><!--]--></p><!--]--></template></x-card>',
    );
  });

  it("値の無い onX の props は、関数の props だけを何もしない関数にする", async () => {
    expect(await renderToString(jsx(Sale, {}))).toContain(
      "<p><!--[-->normal function undefined<!--]--></p>",
    );
  });

  it("関数の props でない props に渡した関数は、呼び出した値にする", async () => {
    expect(await renderToString(jsx(Sale, { label: () => "x" }))).toBe(
      '<x-sale data-oh="h1" label="x"><template shadowrootmode="open"><!--[--><p><!--[-->normal function x<!--]--></p><!--]--></template></x-sale>',
    );
  });

  it("未解決の値を読む props は、値が解決してからホストを出力する", async () => {
    const Outer = defineElement(
      "x-outer-pending",
      () => {
        const name = memo(() => Promise.resolve("ann"));
        return jsx(Card, {
          get label() {
            return name();
          },
        });
      },
      { props: {} },
    );
    expect(await renderToString(jsx(Outer, {}))).toBe(
      '<x-outer-pending data-oh="h1"><template shadowrootmode="open"><!--[--><x-card data-oh="h2" label="ann"><template shadowrootmode="open"><!--[--><p><!--[-->ann<!--]--></p><!--]--></template></x-card><!--]--></template></x-outer-pending>',
    );
  });

  it("スロットの内容に記述した slot 属性は、スロットの名前で置き換える", async () => {
    const html = await renderToString(
      jsx(Card, { header: jsx("h1", { slot: "x", children: "a" }) }),
    );
    expect(html).toContain('<h1 slot="header">a</h1>');
  });

  it("スロットの内容に置いた要素の slot 属性も、スロットの名前で置き換える", async () => {
    const html = await renderToString(jsx(Card, { header: jsx(Card, { slot: "x" }) }));
    expect(html).toContain('<x-card data-oh="h2" slot="header">');
  });

  it("属性の名前に使用できない文字があれば、エラーにする", async () => {
    await expect(renderToString(jsx("p", { 'x"><b': "v" }))).rejects.toThrow(
      "使用できない文字が含まれています",
    );
  });

  it("描画を中断して捨てた穴の失敗は、処理されない reject にならない", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const html = await renderToString(
        jsx(Errored, { fallback, children: [jsx(Async, {}), jsx(Sync, {})] }),
      );
      expect(html).toBe("failed: sync");
      await expect(renderToString([jsx(Async, {}), jsx(Sync, {})])).rejects.toThrow("sync");
      const Boom = defineElement("x-boom", () => jsx(Sync, {}), { props: { label: "unknown" } });
      const Pending = defineElement(
        "x-pending-host",
        () => {
          const failing = memo(() => Promise.reject(new Error("late")));
          return jsx(Boom, {
            get label() {
              return failing();
            },
          });
        },
        { props: {} },
      );
      expect(await renderToString(jsx(Errored, { fallback, children: jsx(Pending, {}) }))).toBe(
        "failed: sync",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", record);
    }
    expect(unhandled).toEqual([]);
  });
});

describe("要素の外のイベントハンドラー", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Shadow DOM の中の `<button>` に onClick を渡す要素である。 */
  const Clicker = defineElement(
    "x-clicker",
    () => jsx("button", { onClick: () => {}, children: "in" }),
    { props: {} },
  );

  it("要素の外のネイティブのタグに渡したイベントハンドラーは、開発時に警告し、要素の中では警告しない", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = await renderToString([
      jsx("button", { onClick: () => {}, children: "out" }),
      jsx(Clicker, {}),
    ]);
    expect(html).toContain("<button>out</button>");
    expect(warn.mock.calls).toEqual([
      ["[rinka] 要素の外の <button> に渡した onClick は、ブラウザで実行されません。"],
    ]);
  });

  it("文書の <html> と <body> に渡したイベントハンドラーも、開発時に警告する", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await (
      await renderToResponse(
        jsx("html", {
          onClick: () => {},
          children: jsx("body", { onLoad: () => {}, children: "x" }),
        }),
      )
    ).text();
    expect(warn.mock.calls).toEqual([
      ["[rinka] 要素の外の <html> に渡した onClick は、ブラウザで実行されません。"],
      ["[rinka] 要素の外の <body> に渡した onLoad は、ブラウザで実行されません。"],
    ]);
  });

  it("<head> に移動するタグに渡したイベントハンドラーは、1 回だけ警告する", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await (
      await renderToResponse(jsx("link", { rel: "icon", href: "/a", onLoad: () => {} }))
    ).text();
    expect(warn.mock.calls).toEqual([
      ["[rinka] 要素の外の <link> に渡した onLoad は、ブラウザで実行されません。"],
    ]);
  });

  it("開発時でなければ警告しない", async () => {
    vi.stubEnv("DEV", false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await renderToString(jsx("button", { onClick: () => {} }));
    expect(warn).not.toHaveBeenCalled();
  });
});

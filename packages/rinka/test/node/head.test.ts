import { afterEach, describe, expect, it, vi } from "vitest";

import { Errored, Loading, Navigation } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { createApp } from "../../src/server/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToResponse, renderToString } from "../../src/server/render.ts";
import type { Route, RouteComponent } from "../../src/shared/routes.ts";
import { memo } from "../../src/shared/signals.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** `node` を文書として描画し、`<head>` の中身と `<body>` の中身を返す。 */
async function documentOf(node: unknown): Promise<{ head: string; body: string }> {
  const html = await (await renderToResponse(node)).text();
  const match = /^<!doctype html><html><head>(.*)<\/head><body>(.*)<\/body><\/html>$/s.exec(html);
  if (!match) throw new Error(`文書の形ではありません: ${html}`);
  return { head: match[1] ?? "", body: match[2] ?? "" };
}

const title = (text: string) => jsx("title", { children: text });

/** `ms` ミリ秒の後に `node` を返すコンポーネントである。 */
const later = (ms: number, node: unknown) => async () => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return node;
};

const Failing = async () => {
  await Promise.resolve();
  throw new Error("failed");
};

/** 名前付きのスロット `side` を Shadow DOM の最上位に持つ要素である。 */
const Side = defineElement("x-side", () => jsx("slot", { name: "side" }), {
  props: ["side"],
  slots: ["side"],
});

/** Shadow DOM の `<Loading>` の中に、名前の無いスロットを持つ要素である。 */
const Lazy = defineElement(
  "x-lazy",
  () => jsx(Loading, { fallback: "wait", children: jsx("slot", {}) }),
  { props: [] },
);

/** Shadow DOM に `<html>`、`<body>`、`<head>` を持つ要素である。 */
const Rooted = defineElement(
  "x-rooted",
  () => [
    jsx("html", { lang: "en", children: "a" }),
    jsx("body", { class: "b", children: "b" }),
    jsx("head", { children: "c" }),
  ],
  { props: [] },
);

const Titled = defineElement(
  "x-titled",
  () => [title("inner"), jsx("link", { rel: "stylesheet", href: "/x.css" })],
  {
    props: [],
  },
);

describe("文書の <head>", () => {
  it("シェルの中かつ要素の外の <title>、<meta>、<link> を、<head> に移動する", async () => {
    const { head, body } = await documentOf(
      jsx("main", {
        children: [
          title("Home"),
          jsx("meta", { name: "description", content: "d" }),
          jsx("link", { rel: "icon", href: "/i.png" }),
          "text",
        ],
      }),
    );
    expect(head).toBe(
      '<meta charset="utf-8"><title>Home</title><meta name="description" content="d"><link rel="icon" href="/i.png">',
    );
    expect(body).toBe("<main>text</main>");
  });

  it("移動したタグは、非同期のコンポーネントを含めて、文書の順序で並べる", async () => {
    const { head } = await documentOf([
      jsx("link", { rel: "stylesheet", href: "/a.css" }),
      jsx(later(20, jsx("link", { rel: "stylesheet", href: "/b.css" })), {}),
      jsx("link", { rel: "stylesheet", href: "/c.css" }),
    ]);
    expect(head).toBe(
      '<meta charset="utf-8"><link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css"><link rel="stylesheet" href="/c.css">',
    );
  });

  it("<Errored> が受け止めた部分のタグを除き、フォールバックのタグを移動する", async () => {
    const { head } = await documentOf(
      jsx(Errored, {
        fallback: () => title("failed"),
        children: [title("ok"), jsx(Failing, {})],
      }),
    );
    expect(head).toBe('<meta charset="utf-8"><title>failed</title>');
  });

  it("<Loading> の内側のタグは、中身がシェルに揃ったときも移動せず、開発時に警告する", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { head, body } = await documentOf(
      jsx(Loading, { fallback: "wait", children: title("inner") }),
    );
    expect(head).toBe('<meta charset="utf-8">');
    expect(body).toBe("<title>inner</title>");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("<title>"));
  });

  it("後送りにした <Loading> のフォールバックのタグは移動し、中身のタグは移動しない", async () => {
    const { head, body } = await documentOf(
      jsx(Loading, { fallback: title("wait"), children: jsx(later(10, title("done")), {}) }),
    );
    expect(head.startsWith('<meta charset="utf-8"><title>wait</title><script>')).toBe(true);
    expect(head).not.toContain("done");
    expect(body).toContain("<title>done</title>");
  });

  it("要素の中のタグは移動せず、<title> と <meta> だけを開発時に警告する", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { head, body } = await documentOf(jsx(Titled, {}));
    expect(head).not.toContain("<title>");
    expect(body).toContain('<title>inner</title><link rel="stylesheet" href="/x.css">');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("<title>"));
  });

  it("開発時でなければ警告しない", async () => {
    vi.stubEnv("DEV", false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await documentOf(jsx(Loading, { fallback: "wait", children: title("inner") }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("名前付きのスロットに配置する Light DOM の子は、slot 属性を付けずに移動する", async () => {
    const { head, body } = await documentOf(jsx(Side, { side: title("T") }));
    expect(head.startsWith('<meta charset="utf-8"><title>T</title><script>')).toBe(true);
    expect(body).not.toContain("<title");
  });

  it("要素の Shadow DOM の <Loading> の中のスロットに配置する Light DOM の子は、移動しない", async () => {
    const { head, body } = await documentOf(jsx(Lazy, { children: title("L") }));
    expect(head).not.toContain("<title>");
    expect(body).toContain("<title>L</title>");
  });

  it("移動したタグの子に移動するタグがあっても、目印を出力しない", async () => {
    const { head, body } = await documentOf(
      jsx("title", { children: ["a", jsx("meta", { name: "x" })] }),
    );
    expect(head).toBe('<meta charset="utf-8"><title>a<meta name="x"></title>');
    expect(body).toBe("");
  });

  it("<svg> と <noscript> の配下のタグと、itemprop を持つ <meta> は、警告せずに記述した位置に出力する", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { head, body } = await documentOf([
      jsx("svg", { children: [title("icon"), jsx("g", { children: title("group") })] }),
      jsx("noscript", { children: jsx("link", { rel: "stylesheet", href: "/n.css" }) }),
      jsx("div", {
        itemscope: true,
        children: [
          jsx("meta", { itemprop: "name", content: "c" }),
          jsx("link", { itemprop: "url", href: "/u" }),
        ],
      }),
    ]);
    expect(head).toBe('<meta charset="utf-8">');
    expect(body).toBe(
      '<svg><title>icon</title><g><title>group</title></g></svg><noscript><link rel="stylesheet" href="/n.css"></noscript><div itemscope><meta itemprop="name" content="c"><link itemprop="url" href="/u"></div>',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("<noscript> の中の要素の Light DOM の子は、移動しない", async () => {
    const { head, body } = await documentOf(
      jsx("noscript", { children: jsx(Side, { side: jsx("link", { rel: "icon", href: "/i" }) }) }),
    );
    expect(head).not.toContain("/i");
    expect(body).toContain('<link rel="icon" href="/i" slot="side">');
  });

  it("移動できない位置の <link> は、rel の値がすべて <body> でも効果のある値でなければ、開発時に警告する", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await documentOf(
      jsx(Loading, {
        fallback: "wait",
        children: [
          jsx("link", { rel: "stylesheet", href: "/a.css" }),
          jsx("link", { rel: "Preload  prefetch", href: "/b.js" }),
          jsx("link", { rel: "canonical", href: "/c" }),
          jsx("link", { rel: "stylesheet icon", href: "/d" }),
        ],
      }),
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("renderToString は、タグを記述した位置に出力する", async () => {
    expect(await renderToString(jsx("main", { children: title("Home") }))).toBe(
      "<main><title>Home</title></main>",
    );
  });
});

/** `component` を default export するモジュールを読み込む関数を返す。 */
const moduleOf = (component: RouteComponent) => async () => ({ default: component });

/** `layouts` で包んだ `page` を `/` に置いたアプリで、`/` の文書の `<head>` の中身を返す。 */
async function headOfPage(
  page: RouteComponent,
  layouts: readonly RouteComponent[],
): Promise<string> {
  const route: Route = {
    kind: "page",
    path: "/",
    module: moduleOf(page),
    layouts: layouts.map(moduleOf),
    middlewares: [],
  };
  const html = await (await createApp({ routes: [route] }).request("/")).text();
  return /<head>(.*)<\/head>/s.exec(html)?.[1] ?? "";
}

const meta = (props: Record<string, string>) => jsx("meta", props);

type LayoutProps = { children?: unknown };

const siteLayout = (props: LayoutProps) => [
  title("Site"),
  meta({ name: "description", content: "layout" }),
  props.children,
  title("Late"),
];

const describedPage = () => [
  title("Page"),
  meta({ name: "description", content: "page" }),
  meta({ name: "description", content: "page2" }),
];

const outerLayout = (props: LayoutProps) => [props.children, title("Outer")];

const innerLayout = (props: LayoutProps) => [title("Inner"), props.children];

const keyedLayout = (props: LayoutProps) => [
  meta({ property: "og:title", content: "a" }),
  meta({ name: "og:title", content: "b" }),
  meta({ "http-equiv": "refresh", content: "5" }),
  jsx("link", { rel: "canonical", href: "/a" }),
  jsx("link", { rel: "stylesheet", href: "/s.css" }),
  meta({ content: "free" }),
  props.children,
];

const keyedPage = () => [
  meta({ property: "og:title", content: "A" }),
  meta({ "http-equiv": "refresh", content: "10" }),
  jsx("link", { rel: "canonical", href: "/b" }),
  jsx("link", { rel: "stylesheet", href: "/s.css" }),
  meta({ content: "free" }),
];

describe("キーが同じ <head> のタグ", () => {
  it("深いファイルのタグを優先し、同じファイルでは後のタグを、そのキーのタグが最初に現れた位置に出力する", async () => {
    expect(await headOfPage(describedPage, [siteLayout])).toBe(
      '<meta charset="utf-8"><title>Page</title><meta name="description" content="page2">',
    );
  });

  it("内側のレイアウトは、外側のレイアウトより深い", async () => {
    expect(await headOfPage(() => "page", [outerLayout, innerLayout])).toBe(
      '<meta charset="utf-8"><title>Inner</title>',
    );
  });

  it("<meta> は属性の名前と値の組を、<link> は rel が canonical のものをキーにし、キーの無いタグはすべて出力する", async () => {
    expect(await headOfPage(keyedPage, [keyedLayout])).toBe(
      '<meta charset="utf-8">' +
        '<meta property="og:title" content="A">' +
        '<meta name="og:title" content="b">' +
        '<meta http-equiv="refresh" content="10">' +
        '<link rel="canonical" href="/b">' +
        '<link rel="stylesheet" href="/s.css">' +
        '<meta content="free">' +
        '<link rel="stylesheet" href="/s.css">' +
        '<meta content="free">',
    );
  });

  it("<meta charset> は、ページが記述しても、rinka の <meta charset> だけを出力する", async () => {
    expect(await headOfPage(() => meta({ charset: "shift_jis" }), [])).toBe(
      '<meta charset="utf-8">',
    );
  });

  it("キーになる属性の値が未解決でも、値が揃ってからキーを求める", async () => {
    const name = memo(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "description";
    });
    const { head } = await documentOf([
      jsx("meta", { name: () => name(), content: "a" }),
      jsx("meta", { name: () => name(), content: "b" }),
    ]);
    expect(head).toBe('<meta charset="utf-8"><meta name="description" content="b">');
  });
});

/** `layouts` で包んだ `page` を `/` に置いたアプリで、`/` の文書の HTML を返す。 */
async function documentOfPage(
  page: RouteComponent,
  layouts: readonly RouteComponent[],
): Promise<string> {
  const route: Route = {
    kind: "page",
    path: "/",
    module: moduleOf(page),
    layouts: layouts.map(moduleOf),
    middlewares: [],
  };
  return (await createApp({ routes: [route] }).request("/")).text();
}

const rootLayout = (props: LayoutProps) =>
  jsx("html", {
    lang: "ja",
    class: "root",
    children: jsx("body", { class: "app", children: props.children }),
  });

const classPage = () => [jsx("html", { class: "page", children: "page" })];

describe("<html> と <body>", () => {
  it("<html> と <body> の属性を、文書の <html> と <body> の開始タグに移動し、子は記述した位置に出力する", async () => {
    expect(await documentOfPage(() => jsx("p", { children: "page" }), [rootLayout])).toBe(
      '<!doctype html><html lang="ja" class="root"><head><meta charset="utf-8"></head><body class="app"><p>page</p></body></html>',
    );
  });

  it("複数のファイルが同じ属性を記述したときは、属性ごとに深いファイルの値を出力し、別の属性を残す", async () => {
    const html = await documentOfPage(classPage, [rootLayout]);
    expect(html).toBe(
      '<!doctype html><html lang="ja" class="page"><head><meta charset="utf-8"></head><body class="app">page</body></html>',
    );
  });

  it("シェルの <head> の子は、タグの種類にかかわらず <head> に移動し、キーが同じタグは 1 つにする", async () => {
    const { head, body } = await documentOf([
      title("outer"),
      jsx("head", {
        lang: "x",
        children: [title("T"), jsx("script", { src: "/a.js" }), jsx("style", { children: "p{}" })],
      }),
      "text",
    ]);
    expect(head).toBe(
      '<meta charset="utf-8"><title>T</title><script src="/a.js"></script><style>p{}</style>',
    );
    expect(body).toBe("text");
  });

  it("シェルの <head> の中の <Loading> の内側の <title> は、移動せずに開発時に警告する", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { head, body } = await documentOf(
      jsx("head", {
        children: jsx(Loading, { fallback: "wait", children: jsx(later(5, title("late")), {}) }),
      }),
    );
    expect(head).not.toContain("<title>late");
    expect(body).toContain("<title>late</title>");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("同じファイルが同じ属性を 2 回記述したときは後の値を、深いファイルの false は属性を出力しない", async () => {
    const html = await (
      await renderToResponse([
        jsx("html", { lang: "en", class: "a", children: "a" }),
        jsx("html", { lang: "ja", children: "b" }),
      ])
    ).text();
    expect(html.startsWith('<!doctype html><html lang="ja" class="a"><head>')).toBe(true);
    const removed = await documentOfPage(
      () => jsx("html", { class: false, children: "page" }),
      [rootLayout],
    );
    expect(removed.startsWith('<!doctype html><html lang="ja"><head>')).toBe(true);
  });

  it("イベントの関数、ref、slot は、属性にしない", async () => {
    const html = await (
      await renderToResponse(
        jsx("body", { onClick: () => "clicked", ref: () => {}, slot: "s", id: "b", children: "x" }),
      )
    ).text();
    expect(html).toBe(
      '<!doctype html><html><head><meta charset="utf-8"></head><body id="b">x</body></html>',
    );
  });

  it("属性の値が未解決以外の理由で投げたエラーは、<Errored> が受け止める", async () => {
    const html = await (
      await renderToResponse(
        jsx(Errored, {
          fallback: () => "failed",
          children: jsx("html", {
            lang: () => {
              throw new Error("boom");
            },
            children: "x",
          }),
        }),
      )
    ).text();
    expect(html).toBe(
      '<!doctype html><html><head><meta charset="utf-8"></head><body>failed</body></html>',
    );
  });

  it("要素の中の <html>、<body>、<head> は、属性を移動せずに子を描画し、開発時に警告する", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = await (await renderToResponse(jsx(Rooted, {}))).text();
    expect(html).toContain('<html><head><meta charset="utf-8">');
    expect(html).toContain("<body><x-rooted");
    expect(html).toContain('<template shadowrootmode="open">abc</template>');
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("要素の中"));
  });

  it("<Errored> が受け止めた部分の属性を除く", async () => {
    const html = await (
      await renderToResponse(
        jsx(Errored, {
          fallback: () => "failed",
          children: [jsx("html", { lang: "en", children: "x" }), jsx(Failing, {})],
        }),
      )
    ).text();
    expect(html).toBe(
      '<!doctype html><html><head><meta charset="utf-8"></head><body>failed</body></html>',
    );
  });

  it("シェルの時点で未解決の値を読む属性は、出力から除く", async () => {
    const pendingLang = memo(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "ja";
    });
    const html = await (
      await renderToResponse(jsx("html", { lang: () => pendingLang(), dir: "ltr", children: "x" }))
    ).text();
    expect(html).toBe(
      '<!doctype html><html dir="ltr"><head><meta charset="utf-8"></head><body>x</body></html>',
    );
  });

  it("<Loading> の内側の <html>、<body>、<head> は、属性を移動せずに子を描画し、開発時に警告する", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = await (
      await renderToResponse(
        jsx(Loading, {
          fallback: "wait",
          children: [
            jsx("html", { lang: "en", children: "a" }),
            jsx("body", { class: "b", children: "b" }),
            jsx("head", { children: "c" }),
          ],
        }),
      )
    ).text();
    expect(html).toBe(
      '<!doctype html><html><head><meta charset="utf-8"></head><body>abc</body></html>',
    );
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

/** 同一オリジンのリンクのうち `/_rinka/` 以外を、`eagerness` で先読みする Speculation Rules の script である。 */
const prefetchScript = (eagerness: string) =>
  `<script type="speculationrules">${JSON.stringify({
    prefetch: [
      {
        where: { and: [{ href_matches: "/*" }, { not: { href_matches: "/_rinka/*" } }] },
        eagerness,
      },
    ],
  })}</script>`;

const viewTransition = "<style>@view-transition{navigation:auto}</style>";

const navigationLayout = (props: LayoutProps) => [
  jsx(Navigation, { transitions: true, prefetch: "moderate" }),
  props.children,
];

/** Shadow DOM に `<Navigation>` を持つ要素である。 */
const Navigating = defineElement(
  "x-navigating",
  () => jsx(Navigation, { transitions: true, prefetch: "eager" }),
  { props: [] },
);

const noPrefetchLayout = (props: LayoutProps) => [
  props.children,
  jsx(Navigation, { prefetch: false }),
];

describe("<Navigation>", () => {
  it("transitions と prefetch を指定すると、<head> に View Transitions の style と Speculation Rules の script を出力する", async () => {
    expect(await headOfPage(() => "page", [navigationLayout])).toBe(
      `<meta charset="utf-8">${viewTransition}${prefetchScript("moderate")}`,
    );
  });

  it("複数のファイルが記述したときは、props ごとに深いファイルの値を使用する", async () => {
    expect(await headOfPage(() => "page", [navigationLayout, noPrefetchLayout])).toBe(
      `<meta charset="utf-8">${viewTransition}`,
    );
    expect(await headOfPage(() => jsx(Navigation, { prefetch: "eager" }), [navigationLayout])).toBe(
      `<meta charset="utf-8">${viewTransition}${prefetchScript("eager")}`,
    );
    expect(
      await headOfPage(() => jsx(Navigation, { transitions: false }), [navigationLayout]),
    ).toBe(`<meta charset="utf-8">${prefetchScript("moderate")}`);
  });

  it("<Loading> の内側に記述したものは反映せず、開発時に警告する", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { head } = await documentOf(
      jsx(Loading, { fallback: "wait", children: jsx(Navigation, { transitions: true }) }),
    );
    expect(head).toBe('<meta charset="utf-8">');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("<Navigation>"));
  });

  it("要素の中に記述したものは反映せず、開発時に警告する", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { head } = await documentOf(jsx(Navigating, {}));
    expect(head).not.toContain("view-transition");
    expect(head).not.toContain("speculationrules");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("要素の中"));
  });

  it("<svg> と <noscript> の配下に記述したものは反映せず、開発時に警告する", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { head } = await documentOf([
      jsx("svg", { children: jsx(Navigation, { transitions: true }) }),
      jsx("noscript", { children: jsx(Navigation, { prefetch: "eager" }) }),
    ]);
    expect(head).toBe('<meta charset="utf-8">');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("<svg> か <noscript>"));
  });

  it("renderToString は、何も出力しない", async () => {
    expect(await renderToString(jsx(Navigation, { transitions: true }))).toBe("");
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { Errored as ClientErrored, Loading as ClientLoading } from "../../src/client/control.ts";
import { defineElement as defineClient } from "../../src/client/element.ts";
import { jsx as clientJsx } from "../../src/client/jsx-runtime.ts";
import { bootstrapSource } from "../../src/server/bootstrap.ts";
import { Errored as ServerErrored, Loading as ServerLoading } from "../../src/server/control.ts";
import { defineElement as defineServer } from "../../src/server/element.ts";
import { jsx as serverJsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream } from "../../src/server/response.ts";
import { BOUNDARY_ATTRIBUTE, BOUNDARY_END } from "../../src/shared/attributes.ts";
import { siteMemo as memo, signal } from "../../src/shared/signals.ts";

afterEach(() => {
  document.body.replaceChildren();
  delete (globalThis as { $rinka?: unknown }).$rinka;
});

/** タグ名とプロパティから要素を作成する JSX の関数を表す。サーバーとクライアントで、同じ要素の関数を使用する。 */
type H = (type: unknown, props: Record<string, unknown>, key?: string, site?: string) => unknown;

/** 片方の側の JSX の関数と、制御フローのコンポーネントと、要素を登録する関数を表す。 */
interface Side {
  readonly h: H;
  readonly Loading: unknown;
  readonly Errored: unknown;
  readonly define: (tag: string, fn: () => unknown, props?: Record<string, string>) => unknown;
  /** 要素のタグ名の接頭辞である。 */
  readonly prefix: string;
}

const serverSide: Side = {
  h: serverJsx as unknown as H,
  Loading: ServerLoading,
  Errored: ServerErrored,
  define: (tag, fn, props = {}) => defineServer(tag, fn as never, { props: props as never }),
  prefix: "test-hy-s",
};

const clientSide: Side = {
  h: clientJsx as unknown as H,
  Loading: ClientLoading,
  Errored: ClientErrored,
  define: (tag, fn, props = {}) => defineClient(tag, fn as never, { props: props as never }),
  prefix: "test-hy-c",
};

let count = 0;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** スクリプトの本文を実行する。 */
// oxlint-disable-next-line typescript/no-implied-eval
const run = (script: string) => new Function(script)();

/**
 * `root` の子を、ノードの種類、タグ名、テキスト、コメントの列にした文字列を返す。
 * 隣り合うテキストは 1 つにまとめ、空のテキストは除く。要素の Shadow DOM は、その要素の後に続けて列挙する。
 * サーバーだけが出力する、Shadow DOM の直下の `<style>` と `<link>`、フォームの部品の hidden input、`<textarea>` の中身、後送りの境界の目印は除く。
 * 属性は比較しない。引き取ったノードの属性は、クライアントが設定し直すからである。
 * 要素のタグ名は、テストの接頭辞を除いた名前にする。
 */
function shape(root: Node): string {
  const out: string[] = [];
  let text = "";
  const flushText = () => {
    if (text !== "") out.push(JSON.stringify(text));
    text = "";
  };
  for (const node of root.childNodes) {
    if (node instanceof Text) {
      text += node.data;
      continue;
    }
    flushText();
    if (node instanceof Comment) {
      if (!node.data.startsWith(BOUNDARY_END)) out.push(`<!--${node.data}-->`);
    } else if (node instanceof Element) {
      if ((node.localName === "style" || node.localName === "link") && root instanceof ShadowRoot) {
        continue;
      }
      if (node.localName === "template" && node.hasAttribute(BOUNDARY_ATTRIBUTE)) continue;
      if (node.localName === "input" && node.hasAttribute("data-rinka-form")) continue;
      const tag = node.localName.replace(/^test-hy-[sc]-/, "host-");
      const shadow = node.shadowRoot ? `#shadow(${shape(node.shadowRoot)})` : "";
      const inner = node.localName === "textarea" ? "" : shape(node);
      out.push(`<${tag}>${inner}</${tag}>${shadow}`);
    }
  }
  flushText();
  return out.join("");
}

/**
 * `node` をサーバーで描画し、本文を Declarative Shadow DOM として body に配置してから、値と差し替えのスクリプトを実行する。
 * `swap` が `false` なら、スクリプトを実行しない。
 */
async function serve(node: unknown, swap = true): Promise<void> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of renderToStream(node)) text += decoder.decode(chunk);
  run(bootstrapSource);
  const body = text.slice(text.indexOf("<body>") + 6, text.indexOf("</body>"));
  const scripts: string[] = [];
  const markup = body.replaceAll(/<script>(.*?)<\/script>/gs, (_, script: string) => {
    scripts.push(script);
    return "";
  });
  const container = document.createElement("div");
  container.setHTMLUnsafe(markup);
  document.body.append(container);
  if (swap) scripts.forEach(run);
}

/** 要素の関数を作成する。`define` は、子要素を同じ側で登録するために使用する。 */
type Fixture = (
  side: Side,
  define: (name: string, fn: () => unknown, props?: Record<string, string>) => unknown,
) => () => unknown;

/** `fixture` の要素を、サーバーで描画した DSD と、クライアントだけで描画した DOM の形にして返す。 */
async function shapes(fixture: Fixture, swap = true): Promise<{ server: string; client: string }> {
  const id = ++count;
  const definer =
    (side: Side) => (name: string, fn: () => unknown, props?: Record<string, string>) =>
      side.define(`${side.prefix}-${id}-${name}`, fn, props);
  const serverTag = `${serverSide.prefix}-${id}`;
  await serve(
    serverSide.h(serverSide.define(serverTag, fixture(serverSide, definer(serverSide))), {}),
    swap,
  );
  const ssr = document.querySelector(serverTag)?.shadowRoot;
  const clientTag = `${clientSide.prefix}-${id}`;
  clientSide.define(clientTag, fixture(clientSide, definer(clientSide)));
  const host = document.createElement(clientTag);
  document.body.append(host);
  await tick();
  await tick();
  return { server: ssr ? shape(ssr) : "", client: host.shadowRoot ? shape(host.shadowRoot) : "" };
}

describe("サーバーとクライアントの DOM の構造", () => {
  const cases: [string, Fixture][] = [
    [
      "静的なテキストと式が隣り合う",
      ({ h }) =>
        () => {
          const [name] = signal("ann");
          return h("p", { children: ["a ", () => name(), " b"] });
        },
    ],
    [
      "静的な文字列が隣り合う",
      ({ h }) =>
        () =>
          h("p", { children: ["a", "b"] }),
    ],
    [
      "条件で空になる領域",
      ({ h }) =>
        () =>
          h("div", { children: [h("span", {}), () => false, h("b", {})] }),
    ],
    [
      "配列を返す領域",
      ({ h }) =>
        () =>
          h("ul", { children: () => ["x", "y"].map((item) => h("li", { children: item })) }),
    ],
    [
      "関数を返すコンポーネント",
      ({ h }) =>
        () =>
          h("p", { children: h(() => () => "x", {}) }),
    ],
    [
      "解決済みの <Loading>",
      ({ h, Loading }) =>
        () =>
          h(Loading, { fallback: "wait", children: () => h("p", { children: "in" }) }),
    ],
    [
      "非同期の memo を待つ <Loading>",
      ({ h, Loading }) =>
        () =>
          h(Loading, {
            fallback: "wait",
            children: () => {
              const value = memo(() => Promise.resolve("late"), { site: "hy:1" });
              return h("p", { children: () => value() });
            },
          }),
    ],
    [
      "エラーの無い <Errored>",
      ({ h, Errored }) =>
        () =>
          h(Errored, { fallback: "err", children: () => h("p", { children: "ok" }) }),
    ],
    [
      "<textarea> の値",
      ({ h }) =>
        () =>
          h("textarea", { value: "t" }),
    ],
    [
      "子要素",
      ({ h }, define) =>
        () =>
          h(
            define("child", () => h("i", { children: () => "c" })),
            {},
          ),
    ],
    [
      "名前付きスロットのテキスト",
      ({ h }, define) => {
        const card = define("card", () => h("section", { children: h("slot", { name: "head" }) }), {
          head: "slot",
        });
        return () => h(card, { head: ["見出し", h("b", { children: "b" })] });
      },
    ],
    [
      "タグの中の <Loading> と <Errored>",
      ({ h, Loading, Errored }) =>
        () =>
          h("div", {
            children: [
              h(Loading, { fallback: "wait", children: () => h("p", { children: "in" }) }),
              h(Errored, { fallback: "err", children: () => h("p", { children: "ok" }) }),
              h(Errored, {
                fallback: () => h("i", { children: "caught" }),
                children: () => {
                  throw new Error("e");
                },
              }),
            ],
          }),
    ],
    [
      "タグの中の、非同期の memo を待つ <Loading>",
      ({ h, Loading }) =>
        () =>
          h("div", {
            children: h(Loading, {
              fallback: "wait",
              children: () => {
                const value = memo(() => Promise.resolve("late"), { site: "hy:2" });
                return [h("p", { children: () => value() }), () => "tail"];
              },
            }),
          }),
    ],
    [
      "子要素が関数を返す",
      ({ h }, define) =>
        () =>
          h("div", {
            children: h(
              define("child", () => () => [h("i", {}), () => "t"]),
              {},
            ),
          }),
    ],
    [
      "getter で渡したスロットの内容",
      ({ h }, define) => {
        const card = define(
          "card",
          () => h("section", { children: [h("slot", { name: "head" }), h("slot", {})] }),
          { head: "slot", children: "slot" },
        );
        return () =>
          h(card, {
            get head() {
              return ["見出し", h("b", { children: "b" })];
            },
            get children() {
              return h("p", { children: () => "body" });
            },
          });
      },
    ],
    [
      "後送りの境界の中の <slot> に、getter で渡したスロットの内容",
      ({ h, Loading }, define) => {
        const card = define(
          "card",
          () =>
            h(Loading, {
              fallback: "wait",
              children: () => {
                const value = memo(() => Promise.resolve("late"), { site: "hy:4" });
                return [h("p", { children: () => value() }), h("slot", {})];
              },
            }),
          { children: "slot" },
        );
        return () =>
          h(card, {
            get children() {
              return ["x", () => "y"];
            },
          });
      },
    ],
    [
      "<Loading> の中で作成した要素の、getter で渡したスロットの内容",
      ({ h, Loading }, define) => {
        const card = define("card", () => h("section", { children: h("slot", {}) }), {
          children: "slot",
        });
        return () =>
          h(Loading, {
            fallback: "wait",
            children: () =>
              h(card, {
                get children() {
                  return ["x", () => "y"];
                },
              }),
          });
      },
    ],
  ];

  it.each(cases)("%s", async (_, fixture) => {
    const { server, client } = await shapes(fixture);
    expect(server).toBe(client);
  });

  it("<table> の直下の <tr> は、HTML の解析が <tbody> を補うので一致しない", async () => {
    const { server, client } = await shapes(
      ({ h }) =>
        () =>
          h("table", { children: h("tr", { children: h("td", { children: "c" }) }) }),
    );
    expect(server).toContain("<tbody>");
    expect(client).not.toContain("<tbody>");
  });

  it("タグの中の保留中の <Loading> のフォールバック", async () => {
    const { server, client } = await shapes(
      ({ h, Loading, prefix }) =>
        () =>
          h("div", {
            children: h(Loading, {
              fallback: ["w", () => "x"],
              children: () => {
                const value = memo(
                  () =>
                    prefix === serverSide.prefix
                      ? new Promise((resolve) => setTimeout(() => resolve("late"), 10))
                      : new Promise(() => {}),
                  { site: "hy:3" },
                );
                return h("p", { children: () => value() });
              },
            }),
          }),
      false,
    );
    expect(server).toBe(client);
  });
});

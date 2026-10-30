import { flush } from "@solidjs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineElement as defineClient } from "../../src/client/element.ts";
import { jsx } from "../../src/client/jsx-runtime.ts";
import { createContext, createId, useContext } from "../../src/client/shared-context.ts";
import { bootstrapSource } from "../../src/server/bootstrap.ts";
import { defineElement as defineServer } from "../../src/server/element.ts";
import { jsx as serverJsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream } from "../../src/server/response.ts";
import * as serverContext from "../../src/server/shared-context.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let count = 0;
const nextTag = () => `test-shared-context-${++count}`;

afterEach(() => {
  document.body.replaceChildren();
  delete (globalThis as { $sobria?: unknown }).$sobria;
  vi.restoreAllMocks();
});

/** ホストの Shadow DOM の、コメントを除いた HTML を返す。 */
const shadow = (host: Element | null | undefined) =>
  (host?.shadowRoot?.innerHTML ?? "").replaceAll(/<!--[[\]]-->/g, "");

/** `tag` の要素を `document.body` に接続し、起動するまで待って返す。 */
async function connect(tag: string): Promise<Element> {
  const host = document.createElement(tag);
  document.body.append(host);
  await tick();
  flush();
  return host;
}

/** スクリプトの本文を実行する。 */
// oxlint-disable-next-line typescript/no-implied-eval
const run = (script: string) => new Function(script)();

/** `node` をサーバーで描画し、起動スクリプトと値を送るスクリプトを実行して、本文の HTML を Declarative Shadow DOM として body に配置する。 */
async function serve(node: unknown): Promise<void> {
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
  scripts.forEach(run);
}

const Theme = createContext("light");

/** `Theme` の値を `<i>` に出力する共通のコンポーネントである。 */
const ThemeName = () => jsx("i", { children: useContext(Theme) });

describe("ブラウザのコンテキスト", () => {
  it("コンテキストのコンポーネントの子孫は値を読み、関数の子でも値を読み、子孫でない位置では初期値を読む", async () => {
    const tag = nextTag();
    defineClient(
      tag,
      () =>
        jsx("div", {
          children: [
            jsx(Theme, {
              value: "dark",
              get children() {
                return jsx("p", {
                  children: [
                    jsx(ThemeName, {}),
                    jsx(Theme, {
                      value: "blue",
                      get children() {
                        return jsx(ThemeName, {});
                      },
                    }),
                  ],
                });
              },
            }),
            jsx(Theme, { value: "red", children: () => jsx(ThemeName, {}) }),
            jsx(ThemeName, {}),
          ],
        }),
      { props: {} },
    );
    expect(shadow(await connect(tag))).toBe(
      "<div><p><i>dark</i><i>blue</i></p><i>red</i><i>light</i></div>",
    );
  });

  it("入れ子の要素の関数と Shadow DOM の中では外側の要素の値を読めず、外側の要素が渡したスロットの内容では読める", async () => {
    const inner = nextTag();
    const outer = nextTag();
    const Inner = defineClient(
      inner,
      () => jsx("p", { title: useContext(Theme), children: [jsx(ThemeName, {}), jsx("slot", {})] }),
      { props: { children: "slot" } },
    );
    defineClient(
      outer,
      () =>
        jsx(Theme, {
          value: "dark",
          get children() {
            return jsx(Inner, {
              get children() {
                return jsx(ThemeName, {});
              },
            });
          },
        }),
      { props: {} },
    );
    const host = await connect(outer);
    const child = host.shadowRoot?.querySelector(inner);
    expect([shadow(child), child?.innerHTML.replaceAll(/<!--[[\]]-->/g, "")]).toEqual([
      '<p title="light"><i>light</i><slot></slot></p>',
      "<i>dark</i>",
    ]);
  });

  it("入れ子の要素の props の getter は、外側の要素の値を読む", async () => {
    const inner = nextTag();
    const outer = nextTag();
    const Inner = defineClient(
      inner,
      (props: { label?: string }) => jsx("b", { children: () => props.label }),
      {
        props: { label: "unknown" },
      },
    );
    defineClient(
      outer,
      () =>
        jsx(Theme, {
          value: "dark",
          get children() {
            return jsx(Inner, {
              get label() {
                return useContext(Theme);
              },
            });
          },
        }),
      { props: {} },
    );
    const host = await connect(outer);
    expect(shadow(host.shadowRoot?.querySelector(inner))).toBe("<b>dark</b>");
  });

  it("子の getter は、コンテキストのコンポーネントの値を読む", async () => {
    const tag = nextTag();
    defineClient(
      tag,
      () =>
        jsx(Theme, {
          value: "dark",
          get children() {
            return useContext(Theme);
          },
        }),
      { props: {} },
    );
    expect(shadow(await connect(tag))).toBe("dark");
  });

  it("子の配列の中の関数は、コンテキストのコンポーネントの値を読む", async () => {
    const tag = nextTag();
    defineClient(
      tag,
      () => jsx(Theme, { value: "dark", children: [jsx("b", {}), () => useContext(Theme)] }),
      { props: {} },
    );
    expect(shadow(await connect(tag))).toBe("<b></b>dark");
  });

  it("createId は、要素のインスタンスごとに 1 から連番の id を返す", async () => {
    const tag = nextTag();
    defineClient(tag, () => jsx("p", { id: createId(), children: jsx("i", { id: createId() }) }), {
      props: {},
    });
    const first = await connect(tag);
    const second = await connect(tag);
    expect([shadow(first), shadow(second)]).toEqual([
      '<p id="sobria-i1"><i id="sobria-i2"></i></p>',
      '<p id="sobria-i1"><i id="sobria-i2"></i></p>',
    ]);
  });

  it("要素の描画の外で useContext と createId を呼ぶと、エラーを投げる", () => {
    expect(() => useContext(Theme)).toThrow(/描画の中/);
    expect(() => createId()).toThrow(/描画の中/);
  });

  it("SSR した要素の DOM を引き取ると、ラベルと入力欄の id をブラウザで作成した id にそろえる", async () => {
    const tag = nextTag();
    type H = (type: unknown, props: Record<string, unknown>) => unknown;
    /** id で `<label>` と `<input>` を関連付ける共通のコンポーネントを、JSX の関数 `h` と `createId` で作成する。 */
    const field = (h: H, id: () => string) => () => {
      const input = id();
      return h("label", { for: input, children: ["name", h("input", { id: input })] });
    };
    /** 先に評価する兄弟と、タグの中で後から評価するフィールドを持つ要素の関数を作成する。 */
    const view = (h: H, id: () => string) => () => [
      h("div", {
        get children() {
          return h(field(h, id), {});
        },
      }),
      h(field(h, id), {}),
    ];
    await serve(
      serverJsx(
        defineServer(tag, view(serverJsx as unknown as H, serverContext.createId), { props: {} }),
        {},
      ),
    );
    const host = document.querySelector(tag);
    /** Shadow DOM の `<label>` ごとに、`for` と、中の `<input>` の `id` を返す。 */
    const pairs = () =>
      [...(host?.shadowRoot?.querySelectorAll("label") ?? [])].map((label) => [
        label.htmlFor,
        label.querySelector("input")?.id,
      ]);
    expect(pairs()).toEqual([
      ["sobria-i1", "sobria-i1"],
      ["sobria-i2", "sobria-i2"],
    ]);
    const inputs = [...(host?.shadowRoot?.querySelectorAll("input") ?? [])];
    defineClient(tag, view(jsx as unknown as H, createId), { props: {} });
    await tick();
    flush();
    // ブラウザは、タグの外の兄弟を先に評価するので、後のフィールドが先に id を受け取る
    const [first, second] = pairs();
    expect([first?.[0] === first?.[1], second?.[0] === second?.[1], second?.[0]]).toEqual([
      true,
      true,
      "sobria-i1",
    ]);
    expect(first?.[0]).not.toBe("sobria-i1");
    expect([...(host?.shadowRoot?.querySelectorAll("input") ?? [])]).toEqual(inputs);
  });
});

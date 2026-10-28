import { describe, expect, it } from "vitest";

import { defineElement } from "../../src/server/element.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToString } from "../../src/server/response.ts";
import { createContext, createId, useContext } from "../../src/server/shared-context.ts";

const Theme = createContext("light");

/** `Theme` の値を `<i>` に出力する共通のコンポーネントである。 */
const ThemeName = () => jsx("i", { children: useContext(Theme) });

/** `createId()` が返した id を、`<i>` の `id` に出力する共通のコンポーネントである。 */
const Identified = () => jsx("i", { id: createId() });

describe("サーバーのコンテキスト", () => {
  it("コンテキストのコンポーネントの子孫は値を読み、子孫でない位置では初期値を読む", async () => {
    const html = await renderToString(
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
          jsx(ThemeName, {}),
        ],
      }),
    );
    expect(html).toBe("<div><p><i>dark</i><i>blue</i></p><i>light</i></div>");
  });

  it("async のコンポーネントは、await の後でも値を読む", async () => {
    const Late = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return jsx("i", { children: useContext(Theme) });
    };
    const html = await renderToString(
      jsx(Theme, {
        value: "dark",
        get children() {
          return jsx(Late, {});
        },
      }),
    );
    expect(html).toBe("<i>dark</i>");
  });

  it("関数の子は、コンテキストのコンポーネントの値を読む", async () => {
    const html = await renderToString(
      jsx(Theme, { value: "dark", children: () => jsx("i", { children: useContext(Theme) }) }),
    );
    expect(html).toBe("<i>dark</i>");
  });

  it("ページで設定した値は、要素の関数と、要素の中の共通のコンポーネントでは読めず、要素の Light DOM のスロットの内容では読める", async () => {
    const Boxed = defineElement(
      "x-themed-box",
      (props: { children?: unknown }) =>
        jsx("p", { title: useContext(Theme), children: [jsx(ThemeName, {}), props.children] }),
      { props: { children: "slot" } },
    );
    const html = await renderToString(
      jsx(Theme, {
        value: "dark",
        get children() {
          return jsx(Boxed, {
            get children() {
              return jsx(ThemeName, {});
            },
          });
        },
      }),
    );
    expect(html).toContain('<p title="light"><i>light</i>');
    expect(html).toMatch(/<\/template><i>dark<\/i><\/x-themed-box>$/);
  });

  it("createId は、ページの描画ごとに 1 から連番の id を返し、要素のインスタンスごとに 1 から数え直す", async () => {
    const Ids = defineElement(
      "x-ids",
      () => jsx("p", { id: createId(), children: jsx(Identified, {}) }),
      { props: {} },
    );
    const page = () =>
      jsx("div", {
        children: [jsx(Identified, {}), jsx(Ids, {}), jsx(Ids, {}), jsx(Identified, {})],
      });
    const html = await renderToString(page());
    expect(html.match(/ id="[^"]*"/g)).toEqual([
      ' id="rinka-i1"',
      ' id="rinka-i1"',
      ' id="rinka-i2"',
      ' id="rinka-i1"',
      ' id="rinka-i2"',
      ' id="rinka-i2"',
    ]);
    expect(await renderToString(page())).toBe(html);
  });

  it("描画の外で useContext と createId を呼ぶと、エラーを投げる", () => {
    expect(() => useContext(Theme)).toThrow(/描画の中/);
    expect(() => createId()).toThrow(/描画の中/);
  });
});

import { describe, expect, it } from "vitest";

import { Errored } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToString } from "../../src/server/response.ts";
import { createContext, createId, useContext } from "../../src/server/shared-context.ts";
import type { Ctx } from "../../src/shared/element.ts";
import type { SharedContext } from "../../src/shared/shared-context.ts";

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
      ' id="sobria-i1"',
      ' id="sobria-i1"',
      ' id="sobria-i2"',
      ' id="sobria-i1"',
      ' id="sobria-i2"',
      ' id="sobria-i2"',
    ]);
    expect(await renderToString(page())).toBe(html);
  });

  it("getter の value は、コンテキストのコンポーネントを記述した位置の範囲で読む", async () => {
    const html = await renderToString(
      jsx(Theme, {
        value: "dark",
        get children() {
          return jsx(Theme, {
            get value() {
              return `${useContext(Theme)} ${createId()}`;
            },
            get children() {
              return jsx(ThemeName, {});
            },
          });
        },
      }),
    );
    expect(html).toBe("<i>dark sobria-i1</i>");
  });

  it("要素の props の getter は、要素を記述した位置の範囲で読む", async () => {
    const Labeled = defineElement(
      "x-themed-label",
      (props: { label?: string }) => jsx("b", { children: () => props.label }),
      { props: { label: "unknown" } },
    );
    const html = await renderToString(
      jsx(Theme, {
        value: "dark",
        get children() {
          return jsx(Labeled, {
            get label() {
              return useContext(Theme);
            },
          });
        },
      }),
    );
    expect(html).toContain('label="dark"');
    expect(html).toContain("<b><!--[-->dark<!--]--></b>");
  });

  it("ネイティブのタグの子、<Errored> のフォールバック、<html> の属性、要素のスロットの getter は、記述した位置の値を読む", async () => {
    const Boxed = defineElement("x-themed-slot", () => jsx("slot", {}), {
      props: { children: "slot" },
    });
    const html = await renderToString(
      jsx(Theme, {
        value: "dark",
        get children() {
          return jsx("html", {
            lang: () => useContext(Theme),
            children: [
              jsx("b", {
                get children() {
                  return useContext(Theme);
                },
              }),
              jsx(Errored, {
                fallback: () => jsx("u", { children: useContext(Theme) }),
                children: () => {
                  throw new Error("failed");
                },
              }),
              jsx(Boxed, {
                get children() {
                  return useContext(Theme);
                },
              }),
            ],
          });
        },
      }),
    );
    expect(html).toContain('<html lang="dark">');
    expect(html).toContain("<b>dark</b>");
    expect(html).toContain("<u>dark</u>");
    expect(html).toContain("</template>dark</x-themed-slot>");
  });

  it.each([
    ["関数", (Off: SharedContext<boolean>) => ({ disabled: () => useContext(Off) })],
    [
      "getter",
      (Off: SharedContext<boolean>) => ({
        get disabled() {
          return useContext(Off);
        },
      }),
    ],
  ])(
    "%s の <fieldset disabled> は、記述した位置の値で中のフォームの部品を無効にし、<legend> の中の部品は無効にしない",
    async (_kind, disabledOf) => {
      const Off = createContext(false);
      const Field = defineElement(
        "x-context-field",
        (_props: object, { form }: Ctx) => {
          form.value(() => "a");
          return jsx("button", { disabled: () => form.disabled() });
        },
        { props: {}, form: true },
      );
      const html = await renderToString(
        jsx(Off, {
          value: true,
          get children() {
            // disabled の getter を評価しないように、オブジェクトを展開せずに children を加える
            return jsx(
              "fieldset",
              Object.defineProperty(disabledOf(Off), "children", {
                enumerable: true,
                value: [
                  jsx("legend", { children: jsx(Field, { name: "l" }) }),
                  jsx(Off, {
                    value: false,
                    get children() {
                      return jsx(Field, { name: "n" });
                    },
                  }),
                ],
              }),
            );
          },
        }),
      );
      expect(html).toMatch(/<fieldset disabled>/);
      expect(html).toContain('name="l" value="a" data-sobria-form>');
      expect(html).toContain('name="n" value="a" data-sobria-form disabled>');
      expect(html.match(/<button[^>]*>/g)).toEqual(["<button>", "<button disabled>"]);
    },
  );

  it("要素に関数で渡した props は、要素の関数と form.disabled() でも、記述した位置の値になる", async () => {
    const Off = createContext(false);
    const Labeled = defineElement(
      "x-context-reader",
      (props: { label?: string }) => jsx("i", { children: () => props.label }),
      { props: { label: "unknown" } },
    );
    const Field = defineElement(
      "x-context-reader-field",
      (_props: object, { form }: Ctx) => {
        form.value(() => "a");
        return jsx("button", { disabled: () => form.disabled() });
      },
      { props: {}, form: true },
    );
    const html = await renderToString(
      jsx(Theme, {
        value: "dark",
        get children() {
          return jsx(Off, {
            value: true,
            get children() {
              return [
                jsx(Labeled, { label: () => useContext(Theme) }),
                jsx(Field, { name: "n", disabled: () => useContext(Off) }),
              ];
            },
          });
        },
      }),
    );
    expect(html).toContain("<i><!--[-->dark<!--]--></i>");
    expect(html).toContain("<button disabled>");
    expect(html).toContain('name="n" value="a" data-sobria-form disabled>');
  });

  it("<select value> は、記述した位置の値で <option> を選択する", async () => {
    const Sel = createContext("");
    const html = await renderToString(
      jsx(Sel, {
        value: "b",
        get children() {
          return jsx("select", {
            value: () => useContext(Sel),
            children: jsx(Sel, {
              value: "a",
              get children() {
                return [jsx("option", { value: "a" }), jsx("option", { value: "b" })];
              },
            }),
          });
        },
      }),
    );
    expect(html).toBe(
      '<select><option value="a"></option><option value="b" selected></option></select>',
    );
  });

  it("コンテキストのコンポーネントの子の getter は、値を加えた範囲で読む", async () => {
    const html = await renderToString(
      jsx(Theme, {
        value: "dark",
        get children() {
          return useContext(Theme);
        },
      }),
    );
    expect(html).toBe("dark");
  });

  it("描画の外でコンテキストのコンポーネントを呼ぶと、エラーを投げる", () => {
    expect(() => Theme({ value: "dark" })).toThrow(/コンテキストのコンポーネントは/);
  });

  it("描画の外で useContext と createId を呼ぶと、エラーを投げる", () => {
    expect(() => useContext(Theme)).toThrow(/描画の中/);
    expect(() => createId()).toThrow(/描画の中/);
  });
});

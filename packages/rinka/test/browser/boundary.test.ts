import { createRoot, flush } from "@solidjs/signals";
import { afterEach, describe, expect, it } from "vitest";

import { Errored, Loading } from "../../src/client/control.ts";
import { defineElement } from "../../src/client/element.ts";
import { jsx } from "../../src/client/jsx-runtime.ts";
import { memo, signal } from "../../src/shared/signals.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let count = 0;
const nextTag = () => `test-boundary-${++count}`;

afterEach(() => {
  document.body.replaceChildren();
});

/** ノードの、コメントを除いた HTML を返す。 */
const html = (node: Element | ShadowRoot) => node.innerHTML.replaceAll("<!---->", "");

/** 値が解決するまで保留中になる要素を登録する。 */
function definePending() {
  const { promise, resolve } = Promise.withResolvers<string>();
  const Pending = defineElement(
    nextTag(),
    () => {
      const value = memo(() => promise);
      return jsx("i", { children: () => value() });
    },
    { props: [] },
  );
  return { Pending, resolve };
}

/** 名前の無いスロットを `<Loading>` で囲んで描画する要素を登録する。 */
const defineCard = () =>
  defineElement(
    nextTag(),
    () =>
      jsx(Loading, {
        fallback: "wait",
        get children() {
          return jsx("slot", {});
        },
      }),
    { props: ["children"] },
  );

describe("Loading と Errored", () => {
  it("Loading は、内側の値が初めて解決するまで fallback を表示する", async () => {
    const { promise, resolve } = Promise.withResolvers<string>();
    const node = createRoot(() => {
      const value = memo(() => promise);
      return jsx("p", {
        children: jsx(Loading, {
          fallback: "loading",
          get children() {
            return jsx("b", { children: () => value() });
          },
        }),
      });
    }) as unknown as HTMLElement;
    flush();
    expect(html(node)).toBe("loading");
    resolve("done");
    await tick();
    flush();
    expect(html(node)).toBe("<b>done</b>");
  });

  it("Errored の fallback の関数は、内側で投げられたエラーと、内側を作り直す retry を受け取る", () => {
    const [broken, setBroken] = signal(true);
    let retry!: () => void;
    const node = createRoot(() =>
      jsx("p", {
        children: jsx(Errored, {
          fallback: (error: unknown, reset: () => void) => {
            retry = reset;
            return `error: ${(error as Error).message}`;
          },
          get children() {
            return jsx("b", {
              children: () => {
                if (broken()) throw new Error("x");
                return "ok";
              },
            });
          },
        }),
      }),
    ) as unknown as HTMLElement;
    flush();
    expect(html(node)).toBe("error: x");
    setBroken(false);
    retry();
    flush();
    expect(html(node)).toBe("<b>ok</b>");
  });
});

describe("境界を探す規則", () => {
  it("子要素の未解決の値は、Shadow DOM の境界をまたいで親の Loading が受け止める", async () => {
    const { Pending, resolve } = definePending();
    const Parent = defineElement(
      nextTag(),
      () =>
        jsx(Loading, {
          fallback: "wait",
          get children() {
            return jsx(Pending, {});
          },
        }),
      { props: [] },
    );
    const el = createRoot(() => jsx(Parent, {})) as unknown as HTMLElement;
    document.body.append(el);
    flush();
    expect(html(el.shadowRoot!)).toBe("wait");
    resolve("v");
    await tick();
    flush();
    const child = el.shadowRoot!.firstElementChild!;
    expect(html(child.shadowRoot!)).toBe("<i>v</i>");
  });

  it("スロットに配置した子要素の未解決の値は、<slot> を囲むホストの Loading が受け止める", async () => {
    const { Pending, resolve } = definePending();
    const Card = defineCard();
    const el = createRoot(() =>
      jsx(Card, {
        get children() {
          return jsx(Pending, {});
        },
      }),
    ) as unknown as HTMLElement;
    document.body.append(el);
    flush();
    expect(html(el.shadowRoot!)).toBe("wait");
    resolve("v");
    await tick();
    flush();
    expect(html(el.shadowRoot!)).toBe("<slot></slot>");
    expect(html(el.firstElementChild!.shadowRoot!)).toBe("<i>v</i>");
  });
});

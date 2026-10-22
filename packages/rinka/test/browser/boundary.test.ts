import { createRoot, flush, onCleanup } from "@solidjs/signals";
import { afterEach, describe, expect, it } from "vitest";

import { Errored, Loading } from "../../src/client/control.ts";
import { defineElement } from "../../src/client/element.ts";
import { jsx } from "../../src/client/jsx-runtime.ts";
import { elementInfo } from "../../src/shared/element.ts";
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

/** 起動すると、`broken` が true の間はエラーを投げる要素を登録する。 */
function defineThrowing(broken: () => boolean) {
  return defineElement(
    nextTag(),
    () =>
      jsx("i", {
        children: () => {
          if (broken()) throw new Error("x");
          return "ok";
        },
      }),
    { props: [] },
  );
}

/** 起動した回数と、描画の範囲を破棄した回数を数える要素を登録する。 */
function defineCounting() {
  const counts = { runs: 0, cleanups: 0 };
  const Counting = defineElement(
    nextTag(),
    () => {
      counts.runs++;
      onCleanup(() => counts.cleanups++);
      return jsx("i", { children: "ok" });
    },
    { props: [] },
  );
  return { Counting, counts };
}

/** 名前の無いスロットを `<Errored>` で囲んで描画する要素を登録する。 */
const defineGuard = (show: () => boolean = () => true, fallback = "failed") =>
  defineElement(
    nextTag(),
    () =>
      jsx(Errored, {
        fallback,
        get children() {
          return () => (show() ? jsx("slot", {}) : null);
        },
      }),
    { props: ["children"] },
  );

const tagOf = (component: { readonly [elementInfo]: { readonly tag: string } }) =>
  component[elementInfo].tag;

describe("owner の無い場所で作成した要素の境界", () => {
  it("HTML に記述した子要素は、ホストの <slot> の owner の下で起動し、ホストの Errored が子要素のエラーを受け止める", async () => {
    const Guard = defineGuard();
    const Throwing = defineThrowing(() => true);
    document.body.innerHTML = `<${tagOf(Guard)}><${tagOf(Throwing)}></${tagOf(Throwing)}></${tagOf(Guard)}>`;
    await tick();
    flush();
    expect(html(document.body.firstElementChild!.shadowRoot!)).toBe("failed");
  });

  it("HTML に記述した子要素は、ホストがその <slot> を作成するまで起動しない", async () => {
    const [show, setShow] = signal(false);
    const Guard = defineGuard(show);
    const Throwing = defineThrowing(() => false);
    document.body.innerHTML = `<${tagOf(Guard)}><${tagOf(Throwing)}></${tagOf(Throwing)}></${tagOf(Guard)}>`;
    await tick();
    flush();
    const child = document.body.firstElementChild!.firstElementChild!;
    expect(child.shadowRoot).toBeNull();
    setShow(true);
    flush();
    expect(html(child.shadowRoot!)).toBe("<i>ok</i>");
  });

  it("<slot> を待っている間に外した子要素は、別の場所に接続し直すとその場所で起動し、元のホストが <slot> を作成しても起動し直さない", async () => {
    const [show, setShow] = signal(false);
    const Guard = defineGuard(show);
    const { Counting, counts } = defineCounting();
    document.body.innerHTML = `<${tagOf(Guard)}><${tagOf(Counting)}></${tagOf(Counting)}></${tagOf(Guard)}>`;
    await tick();
    const child = document.body.firstElementChild!.firstElementChild!;
    document.body.append(child);
    await tick();
    flush();
    expect(html(child.shadowRoot!)).toBe("<i>ok</i>");
    setShow(true);
    flush();
    expect(counts).toEqual({ runs: 1, cleanups: 0 });
  });

  it("途中の要素の起動を待っている間に外した子要素は、途中の要素が起動しても起動しない", async () => {
    const [show, setShow] = signal(false);
    const Outer = defineGuard(show);
    const Inner = defineGuard();
    const { Counting, counts } = defineCounting();
    const [o, i, c] = [Outer, Inner, Counting].map(tagOf);
    document.body.innerHTML = `<${o}><${i}><${c}></${c}></${i}></${o}>`;
    await tick();
    const inner = document.body.firstElementChild!.firstElementChild!;
    inner.firstElementChild!.remove();
    setShow(true);
    flush();
    expect(counts.runs).toBe(0);
    await tick();
    expect(counts.runs).toBe(0);
  });

  it("<slot> を待っている間に別の要素の Light DOM へ移動した子要素は、移動した先の要素の <slot> の下で起動する", async () => {
    const [show, setShow] = signal(false);
    const Outer = defineGuard(show, "outer");
    const Inner = defineGuard(() => true, "inner");
    const Other = defineGuard(() => true, "other");
    const Throwing = defineThrowing(() => true);
    const [o, i, x, t] = [Outer, Inner, Other, Throwing].map(tagOf);
    document.body.innerHTML = `<${o}><${i}><${t}></${t}></${i}></${o}><${x}></${x}>`;
    await tick();
    const inner = document.body.firstElementChild!.firstElementChild!;
    const other = document.body.lastElementChild!;
    other.append(inner.firstElementChild!);
    setShow(true);
    flush();
    await tick();
    flush();
    expect(html(inner.shadowRoot!)).toBe("<slot></slot>");
    expect(html(other.shadowRoot!)).toBe("other");
  });

  it("途中の要素が <slot> を待っていれば、子要素は、その要素が <slot> を作成した時点で起動し、その要素の Loading がフォールバックを表示する", async () => {
    const [show, setShow] = signal(false);
    const Outer = defineGuard(show);
    const Card = defineCard();
    const { Pending, resolve } = definePending();
    const [o, c, p] = [Outer, Card, Pending].map(tagOf);
    document.body.innerHTML = `<${o}><${c}><${p}></${p}></${c}></${o}>`;
    await tick();
    flush();
    setShow(true);
    flush();
    const card = document.body.firstElementChild!.firstElementChild!;
    expect(html(card.shadowRoot!)).toBe("wait");
    resolve("v");
    await tick();
    flush();
    expect(html(card.shadowRoot!)).toBe("<slot></slot>");
  });

  it("起動した要素の Shadow DOM に DOM の API で追加した要素は、最上位の要素として、値が解決するまで何も描画しない", async () => {
    const Host = defineElement(nextTag(), () => jsx("div", {}), { props: [] });
    const { Pending, resolve } = definePending();
    const host = jsx(Host, {}) as unknown as HTMLElement;
    document.body.append(host);
    await tick();
    const child = document.createElement(tagOf(Pending));
    host.shadowRoot!.append(child);
    await tick();
    flush();
    expect(html(child.shadowRoot!)).toBe("");
    resolve("v");
    await tick();
    flush();
    expect(html(child.shadowRoot!)).toBe("<i>v</i>");
  });

  it("境界の無い最上位の要素は、値が解決するまで何も描画せず、要素の関数を 1 回だけ呼ぶ", async () => {
    const { promise, resolve } = Promise.withResolvers<string>();
    let runs = 0;
    const Top = defineElement(
      nextTag(),
      () => {
        runs++;
        const value = memo(() => promise);
        return jsx("p", { children: ["[", () => value(), "]"] });
      },
      { props: [] },
    );
    const el = jsx(Top, {}) as unknown as HTMLElement;
    document.body.append(el);
    await tick();
    flush();
    expect(html(el.shadowRoot!)).toBe("");
    resolve("v");
    await tick();
    flush();
    expect(html(el.shadowRoot!)).toBe("<p>[v]</p>");
    expect(runs).toBe(1);
  });
});

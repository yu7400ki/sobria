import { createRoot, flush, onCleanup } from "@solidjs/signals";
import { afterEach, describe, expect, it } from "vitest";

import { defineElement } from "../../src/client/element.ts";
import { jsx, jsxs } from "../../src/client/jsx-runtime.ts";
import { signal } from "../../src/shared/signals.ts";

let count = 0;
/** テストごとに異なるタグ名を返す。 */
const nextTag = () => `test-slot-${++count}`;

afterEach(() => {
  document.body.replaceChildren();
});

/** ホストの Light DOM の、コメントを除いた HTML を返す。 */
const light = (host: Element) => host.innerHTML.replaceAll("<!---->", "");

type CardProps = { header?: unknown; children?: unknown };

/** 名前の無いスロットと header のスロットを描画する要素を登録する。 */
function defineCard(showHeader: () => boolean = () => true) {
  return defineElement(
    nextTag(),
    () =>
      jsxs("section", {
        children: [() => (showHeader() ? jsx("slot", { name: "header" }) : null), jsx("slot", {})],
      }),
    { props: ["header", "children"], slots: ["header"] },
  );
}

describe("Light DOM への配置", () => {
  it("children は属性を付与せずに配置し、名前付きのスロットは最上位の要素に slot 属性を付与し、テキストを span で包む", () => {
    const Card = defineCard();
    const el = createRoot(() =>
      jsx(Card, {
        header: ["見出し", jsx("h1", { children: "a" })],
        children: [jsx("p", { children: "本文" }), "追記"],
      }),
    ) as unknown as HTMLElement & CardProps;
    expect(light(el)).toBe(
      '<span slot="header">見出し</span><h1 slot="header">a</h1><p>本文</p>追記',
    );
    expect(el.header).toBeUndefined();
    expect(el.children).toBeInstanceOf(HTMLCollection);
  });

  it("リアクティブな領域が後から挿入した要素とテキストにも、slot 属性の規則を適用する", () => {
    const Card = defineCard();
    const [rich, setRich] = signal(false);
    const el = createRoot(() =>
      jsx(Card, { header: () => (rich() ? jsx("b", { children: "B" }) : "plain") }),
    ) as unknown as HTMLElement;
    expect(light(el)).toBe('<span slot="header">plain</span>');
    setRich(true);
    flush();
    expect(light(el)).toBe('<b slot="header">B</b>');
  });

  it("スロットに割り当てた内容が、要素の <slot> に表示される", () => {
    const Card = defineCard();
    const el = createRoot(() =>
      jsx(Card, { header: jsx("h1", {}), children: jsx("p", {}) }),
    ) as unknown as HTMLElement;
    document.body.append(el);
    const [header, main] = el.shadowRoot!.querySelectorAll("slot");
    expect(header!.assignedElements().map((e) => e.localName)).toEqual(["h1"]);
    expect(main!.assignedElements().map((e) => e.localName)).toEqual(["p"]);
  });
});

/** 起動した回数を数える子要素を登録する。 */
function defineChild() {
  const runs = { count: 0 };
  const Child = defineElement(
    nextTag(),
    () => {
      runs.count++;
      return jsx("i", { children: "child" });
    },
    { props: [] },
  );
  return { Child, runs };
}

describe("スロットに置いた子要素の起動", () => {
  it("子要素は、ホストがそのスロットの <slot> を作成した時点で起動する", () => {
    const { Child, runs } = defineChild();
    const [show, setShow] = signal(false);
    const Card = defineCard(show);
    const el = createRoot(() =>
      jsx(Card, {
        get header() {
          return jsx(Child, {});
        },
      }),
    ) as unknown as HTMLElement;
    const child = el.querySelector("[slot=header]")!;
    expect(runs.count).toBe(0);
    expect(child.shadowRoot).toBeNull();
    setShow(true);
    flush();
    expect(runs.count).toBe(1);
    expect(child.shadowRoot!.innerHTML).toContain("child");
  });

  it("<slot> を作成した後に挿入した子要素は、挿入した時点で起動する", () => {
    const { Child, runs } = defineChild();
    const Card = defineCard();
    const [more, setMore] = signal(false);
    createRoot(() =>
      jsx(Card, {
        get children() {
          return () => (more() ? jsx(Child, {}) : null);
        },
      }),
    );
    expect(runs.count).toBe(0);
    setMore(true);
    flush();
    expect(runs.count).toBe(1);
  });

  it("ホストが作成したスロットの子要素だけを起動する", () => {
    const { Child, runs } = defineChild();
    const Card = defineCard(() => false);
    createRoot(() =>
      jsx(Card, {
        get header() {
          return jsx(Child, {});
        },
        get children() {
          return jsx(Child, {});
        },
      }),
    );
    expect(runs.count).toBe(1);
  });
});

describe("スロットの owner", () => {
  it("<slot> を消すと子要素を破棄し、再び作成すると子要素を起動し直す", () => {
    let runs = 0;
    let cleanups = 0;
    const Child = defineElement(
      nextTag(),
      () => {
        runs++;
        onCleanup(() => cleanups++);
        return null;
      },
      { props: [] },
    );
    const [show, setShow] = signal(true);
    const Card = defineCard(show);
    createRoot(() =>
      jsx(Card, {
        get header() {
          return jsx(Child, {});
        },
      }),
    );
    expect([runs, cleanups]).toEqual([1, 0]);
    setShow(false);
    flush();
    expect([runs, cleanups]).toEqual([1, 1]);
    setShow(true);
    flush();
    expect([runs, cleanups]).toEqual([2, 1]);
  });

  it("<slot> を待っている子要素は、ホストを document に接続しても起動しない", async () => {
    const { Child, runs } = defineChild();
    const Card = defineCard(() => false);
    const el = createRoot(() =>
      jsx(Card, {
        get header() {
          return jsx(Child, {});
        },
      }),
    ) as unknown as HTMLElement;
    document.body.append(el);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs.count).toBe(0);
  });

  it("<slot> を消した後に挿入した子要素は、再び <slot> を作成するまで起動しない", () => {
    const { Child, runs } = defineChild();
    const [show, setShow] = signal(true);
    const [more, setMore] = signal(false);
    const Card = defineCard(show);
    createRoot(() =>
      jsx(Card, {
        get header() {
          return () => (more() ? jsx(Child, {}) : null);
        },
      }),
    );
    setShow(false);
    flush();
    setMore(true);
    flush();
    expect(runs.count).toBe(0);
    setShow(true);
    flush();
    expect(runs.count).toBe(1);
  });

  it("<slot> を待っている間に Light DOM から外れた子要素は、後で <slot> を作成しても起動しない", () => {
    const { Child, runs } = defineChild();
    const [show, setShow] = signal(false);
    const [more, setMore] = signal(true);
    const Card = defineCard(show);
    createRoot(() =>
      jsx(Card, {
        get header() {
          return () => (more() ? jsx(Child, {}) : null);
        },
      }),
    );
    setMore(false);
    flush();
    setShow(true);
    flush();
    expect(runs.count).toBe(0);
  });

  it("スロットに置いた子要素の Shadow DOM の中で作成した要素は、外側のスロットを待たずに起動する", () => {
    const { Child: Grandchild, runs } = defineChild();
    const Child = defineElement(nextTag(), () => jsx(Grandchild, {}), { props: [] });
    const Inner = defineElement(nextTag(), () => null, { props: ["children"] });
    const Outer = defineElement(
      nextTag(),
      () =>
        jsx(Inner, {
          get children() {
            return jsx("slot", {});
          },
        }),
      { props: ["children"] },
    );
    createRoot(() =>
      jsx(Outer, {
        get children() {
          return jsx(Child, {});
        },
      }),
    );
    expect(runs.count).toBe(1);
  });

  it("owner の無い場所で <slot> を作成しても例外にならない", () => {
    expect(() => jsx("slot", {})).not.toThrow();
  });
});

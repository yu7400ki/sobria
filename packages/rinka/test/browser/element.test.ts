import { createEffect, createRoot, flush, onCleanup } from "@solidjs/signals";
import { afterEach, describe, expect, it } from "vitest";

import { defineElement } from "../../src/client/element.ts";
import { jsx } from "../../src/client/jsx-runtime.ts";
import type { Ctx } from "../../src/shared/element.ts";
import { memo, signal } from "../../src/shared/signals.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let count = 0;
const nextTag = () => `test-el-${++count}`;

afterEach(() => {
  document.body.replaceChildren();
});

/** ホストの Shadow DOM の、コメントを除いた HTML を返す。 */
const shadow = (host: Element) => (host.shadowRoot?.innerHTML ?? "").replaceAll("<!---->", "");

/** ホストを `document.body` に接続し、起動するまで待つ。 */
async function connect<T extends Element>(host: T): Promise<T> {
  document.body.append(host);
  await tick();
  flush();
  return host;
}

/** 何も描画せずに null を返す。 */
const empty = () => null;

type CounterProps = { count?: number; label?: string; on?: boolean };

describe("props と属性", () => {
  it("接続する前と後に設定したプロパティを props として受け取り、変化を表示に反映する", async () => {
    const tag = nextTag();
    defineElement(
      tag,
      (props: CounterProps) => jsx("p", { children: () => `${props.label}:${props.count}` }),
      { props: ["count", "label"] },
    );
    const el = document.createElement(tag) as HTMLElement & CounterProps;
    el.label = "n";
    await connect(el);
    el.count = 1;
    flush();
    expect(shadow(el)).toBe("<p>n:1</p>");
    el.count = 2;
    flush();
    expect(shadow(el)).toBe("<p>n:2</p>");
    expect(el.count).toBe(2);
  });

  it("要素を定義する前に設定したプロパティを、props として引き継ぐ", async () => {
    const tag = nextTag();
    const el = document.createElement(tag) as HTMLElement & CounterProps;
    el.label = "early";
    defineElement(tag, (props: CounterProps) => jsx("p", { children: () => props.label }), {
      props: ["label"],
    });
    customElements.upgrade(el);
    await connect(el);
    expect(shadow(el)).toBe("<p>early</p>");
  });

  it("属性を types に従って変換し、属性を削除すると undefined にする", async () => {
    const tag = nextTag();
    const seen: unknown[] = [];
    defineElement(
      tag,
      (props: CounterProps) => {
        const read = () => [props.count, props.on, props.label];
        return jsx("p", { children: () => String(seen.push(read())) });
      },
      {
        props: ["count", "on", "label"],
        types: { count: "number", on: "boolean" },
      },
    );
    const el = document.createElement(tag);
    el.setAttribute("count", "3");
    el.setAttribute("on", "false");
    el.setAttribute("label", "x");
    await connect(el);
    el.setAttribute("on", "");
    el.removeAttribute("count");
    flush();
    expect(seen.at(0)).toEqual([3, false, "x"]);
    expect(seen.at(-1)).toEqual([undefined, true, "x"]);
  });

  it("observedAttributes は、関数の props とスロットを除いた props の属性名である", () => {
    const tag = nextTag();
    defineElement(tag, () => null, {
      props: ["userId", "onSelect", "header", "render"],
      functionProps: ["onSelect", "render"],
      slots: ["header"],
    });
    const ctor = customElements.get(tag) as unknown as {
      observedAttributes: string[];
    };
    expect(ctor.observedAttributes).toEqual(["user-id"]);
  });

  it("同じ関数を 2 つのタグで登録しても、それぞれの要素コンポーネントは自分のタグで作成する", () => {
    const [a, b] = [nextTag(), nextTag()];
    const A = defineElement(a, empty, { props: [] });
    const B = defineElement(b, empty, { props: [] });
    const [elA, elB] = createRoot(() => [jsx(A, {}), jsx(B, {})]) as unknown as Element[];
    expect(elA!.localName).toBe(a);
    expect(elB!.localName).toBe(b);
  });
});

describe("関数の props", () => {
  type Props = { onLikeClick?: (detail: number) => void };
  const define = () => {
    const tag = nextTag();
    const component = defineElement(
      tag,
      (props: Props) => jsx("button", { onClick: () => props.onLikeClick?.(7) }),
      { props: ["onLikeClick"], functionProps: ["onLikeClick"] },
    );
    return { tag, component };
  };

  it("値が渡されていなければ、ホストから CustomEvent を発行する", async () => {
    const el = await connect(document.createElement(define().tag));
    const events: CustomEvent[] = [];
    document.body.addEventListener("like-click", (e) => events.push(e as CustomEvent));
    el.shadowRoot!.querySelector("button")!.click();
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toBe(7);
    expect(events[0]!.bubbles).toBe(true);
    expect(events[0]!.composed).toBe(true);
  });

  it("プロパティに値が渡されていれば、その関数を呼び、イベントを発行しない", async () => {
    const el = document.createElement(define().tag) as HTMLElement & Props;
    const calls: number[] = [];
    el.onLikeClick = (n) => calls.push(n);
    await connect(el);
    let events = 0;
    el.addEventListener("like-click", () => events++);
    el.shadowRoot!.querySelector("button")!.click();
    expect(calls).toEqual([7]);
    expect(events).toBe(0);
  });

  it("JSX で関数の props に渡した関数は、memo にせずに、要素がそのまま呼ぶ", () => {
    const calls: number[] = [];
    const { component } = define();
    const el = createRoot(() =>
      jsx(component, { onLikeClick: (n: number) => calls.push(n) }),
    ) as unknown as HTMLElement;
    el.shadowRoot!.querySelector("button")!.click();
    expect(calls).toEqual([7]);
  });
});

describe("JSX から使う要素", () => {
  it("関数の値は親の memo にし、変化するたびに 1 回だけ評価する", () => {
    const tag = nextTag();
    const Counter = defineElement(
      tag,
      (props: CounterProps) => jsx("p", { children: () => props.count }),
      { props: ["count"] },
    );
    const [n, setN] = signal(1);
    let evaluated = 0;
    const el = createRoot(() =>
      jsx(Counter, {
        count: () => {
          evaluated++;
          return n();
        },
      }),
    ) as unknown as HTMLElement & CounterProps;
    flush();
    expect(shadow(el)).toBe("<p>1</p>");
    const before = evaluated;
    setN(2);
    flush();
    expect(shadow(el)).toBe("<p>2</p>");
    expect(el.count).toBe(2);
    expect(evaluated - before).toBe(1);
  });

  it("getter で渡した props とホストの属性（関数以外の値の onX を含む）は、親の owner で値の変化に追従する", () => {
    const tag = nextTag();
    const Counter = defineElement(
      tag,
      (props: CounterProps) => jsx("p", { children: () => props.count }),
      { props: ["count"] },
    );
    const [n, setN] = signal(1);
    const el = createRoot(() =>
      jsx(Counter, {
        get count() {
          return n();
        },
        get title() {
          return `t${n()}`;
        },
        get onSale() {
          return n() > 1;
        },
      }),
    ) as unknown as HTMLElement;
    flush();
    setN(2);
    flush();
    expect(shadow(el)).toBe("<p>2</p>");
    expect(el.getAttribute("title")).toBe("t2");
    expect(el.hasAttribute("onsale")).toBe(true);
  });

  it("owner の無い場所で作成した要素は、接続した後に起動し、DOM から外れたときに破棄する", async () => {
    const tag = nextTag();
    let cleanups = 0;
    const refs: string[] = [];
    const Toast = defineElement(
      tag,
      (props: CounterProps) => {
        onCleanup(() => cleanups++);
        return jsx("p", { children: () => props.count });
      },
      { props: ["count"] },
    );
    const [n, setN] = signal(1);
    const el = jsx(Toast, {
      count: () => n(),
      ref: (host: HTMLElement) => refs.push(shadow(host)),
    }) as unknown as HTMLElement;
    await connect(el);
    expect(shadow(el)).toBe("<p>1</p>");
    expect(refs).toEqual(["<p>1</p>"]);
    setN(2);
    flush();
    expect(shadow(el)).toBe("<p>2</p>");
    el.remove();
    await tick();
    expect(cleanups).toBe(1);
  });

  it("effect の中で JSX から作成した要素も起動する", async () => {
    const tag = nextTag();
    const El = defineElement(
      tag,
      (props: CounterProps) => jsx("p", { children: () => props.count }),
      {
        props: ["count"],
      },
    );
    const [show, setShow] = signal(false);
    let el: HTMLElement | undefined;
    createRoot(() =>
      createEffect(show, (visible) => {
        if (visible)
          document.body.append((el = jsx(El, { count: () => 3 }) as unknown as HTMLElement));
      }),
    );
    setShow(true);
    flush();
    await tick();
    flush();
    expect(shadow(el!)).toBe("<p>3</p>");
  });

  it("親の値が未解決の間は、要素はその値を表示せず、onMount を呼ばない", async () => {
    const tag = nextTag();
    const mounted: string[] = [];
    const Counter = defineElement(
      tag,
      (props: CounterProps, ctx: Ctx) => {
        ctx.onMount(() => mounted.push(shadow(ctx.host)));
        return jsx("p", { children: () => `[${props.count}]` });
      },
      { props: ["count"] },
    );
    let resolve!: (value: number) => void;
    const el = createRoot(() => {
      const value = memo(() => new Promise<number>((r) => (resolve = r)));
      return jsx(Counter, { count: () => value() });
    }) as unknown as HTMLElement;
    await connect(el);
    expect(shadow(el)).toBe("<p></p>");
    expect(mounted).toEqual([]);
    expect((el as HTMLElement & CounterProps).count).toBeUndefined();
    resolve(5);
    await tick();
    flush();
    expect(shadow(el)).toBe("<p>[5]</p>");
    expect(mounted).toEqual(["<p>[5]</p>"]);
  });

  it("props に無い値と key はホストの属性にし、props に無い onX の関数はホストのリスナーにする", () => {
    const tag = nextTag();
    const Box = defineElement(tag, () => null, { props: [] });
    const clicks: string[] = [];
    let reads = 0;
    const el = createRoot(() =>
      jsx(
        Box,
        {
          id: "b",
          class: { on: true },
          onClick: (e: Event) => clicks.push(e.type),
          get onDblClick() {
            reads++;
            return (e: Event) => clicks.push(e.type);
          },
        },
        "k1",
      ),
    ) as unknown as HTMLElement;
    expect(el.getAttribute("id")).toBe("b");
    expect(el.getAttribute("class")).toBe("on");
    expect(el.getAttribute("data-ok")).toBe("k1");
    el.click();
    el.dispatchEvent(new MouseEvent("dblclick"));
    expect(clicks).toEqual(["click", "dblclick"]);
    expect(reads).toBe(1);
  });

  it("要素への ref は、起動して expose を実行した後に呼ぶ", () => {
    const tag = nextTag();
    const Dialog = defineElement(
      tag,
      (_props: object, ctx: Ctx<{ open(): string }>) => {
        ctx.expose({ open: () => "opened" });
        return null;
      },
      { props: [] },
    );
    const seen: string[] = [];
    createRoot(() =>
      jsx(Dialog, {
        ref: (el: HTMLElement & { open?: () => string }) => seen.push(el.open?.() ?? "none"),
      }),
    );
    expect(seen).toEqual(["opened"]);
  });
});

describe("ctx", () => {
  it("host はホストの要素である", async () => {
    const tag = nextTag();
    let host: HTMLElement | undefined;
    defineElement(
      tag,
      (_props: object, ctx: Ctx) => {
        host = ctx.host;
        return null;
      },
      { props: [] },
    );
    const el = await connect(document.createElement(tag));
    expect(host).toBe(el);
  });

  it("onMount は、最初の内容を Shadow DOM に表示した後に 1 回だけ呼ぶ", async () => {
    const tag = nextTag();
    const seen: string[] = [];
    defineElement(
      tag,
      (_props: object, ctx: Ctx) => {
        ctx.onMount(() => seen.push(shadow(ctx.host)));
        return jsx("p", { children: "x" });
      },
      { props: [] },
    );
    const el = await connect(document.createElement(tag));
    const other = document.createElement("div");
    document.body.append(other);
    other.append(el);
    await tick();
    expect(seen).toEqual(["<p>x</p>"]);
  });

  it("接続する前に内容を表示した要素は、接続した時点で onMount を呼ぶ", async () => {
    const tag = nextTag();
    const seen: boolean[] = [];
    const El = defineElement(
      tag,
      (_props: object, ctx: Ctx) => {
        ctx.onMount(() => seen.push(ctx.host.isConnected));
        return jsx("p", { children: "x" });
      },
      { props: [] },
    );
    const el = createRoot(() => jsx(El, {})) as unknown as HTMLElement;
    flush();
    expect(seen).toEqual([]);
    document.body.append(el);
    expect(seen).toEqual([true]);
  });

  it("最初の描画が memo の値を待っているときは、値が解決して内容を表示した後に onMount を呼ぶ", async () => {
    const tag = nextTag();
    const seen: string[] = [];
    let resolve!: (value: string) => void;
    defineElement(
      tag,
      (_props: object, ctx: Ctx) => {
        const value = memo(() => new Promise<string>((r) => (resolve = r)));
        ctx.onMount(() => seen.push(shadow(ctx.host)));
        return jsx("p", { children: () => value() });
      },
      { props: [] },
    );
    await connect(document.createElement(tag));
    expect(seen).toEqual([]);
    resolve("done");
    await tick();
    flush();
    expect(seen).toEqual(["<p>done</p>"]);
  });
});

describe("起動と破棄", () => {
  it("effect の中で接続された要素も起動する", async () => {
    const tag = nextTag();
    defineElement(tag, () => jsx("p", { children: "on" }), { props: [] });
    const [show, setShow] = signal(false);
    let el: Element | undefined;
    createRoot(() =>
      createEffect(show, (visible) => {
        if (visible) document.body.append((el = document.createElement(tag)));
      }),
    );
    setShow(true);
    flush();
    await tick();
    flush();
    expect(shadow(el!)).toBe("<p>on</p>");
  });

  it("親の描画の中で作成した要素は、DOM から外れても破棄せず、親の owner を破棄したときに破棄する", async () => {
    const tag = nextTag();
    let cleanups = 0;
    const Child = defineElement(
      tag,
      () => {
        onCleanup(() => cleanups++);
        return null;
      },
      { props: [] },
    );
    const { el, dispose } = createRoot((d) => ({
      el: jsx(Child, {}) as unknown as HTMLElement,
      dispose: d,
    }));
    document.body.append(el);
    el.remove();
    await tick();
    expect(cleanups).toBe(0);
    dispose();
    expect(cleanups).toBe(1);
  });

  it("親の owner が破棄された要素は、別の親へ接続しても起動し直さない", async () => {
    const tag = nextTag();
    let runs = 0;
    const Child = defineElement(
      tag,
      () => {
        runs++;
        return null;
      },
      { props: [] },
    );
    const { el, dispose } = createRoot((d) => ({
      el: jsx(Child, {}) as unknown as HTMLElement,
      dispose: d,
    }));
    document.body.append(el);
    dispose();
    const other = document.createElement("div");
    document.body.append(other);
    other.append(el);
    await tick();
    expect(runs).toBe(1);
  });

  it("最上位の要素は、DOM から外れたときに破棄し、同期的に別の親へ移動したときは破棄しない", async () => {
    const tag = nextTag();
    let cleanups = 0;
    defineElement(
      tag,
      () => {
        onCleanup(() => cleanups++);
        return null;
      },
      { props: [] },
    );
    const el = await connect(document.createElement(tag));
    const other = document.createElement("div");
    document.body.append(other);
    other.append(el);
    await tick();
    expect(cleanups).toBe(0);
    el.remove();
    await tick();
    expect(cleanups).toBe(1);
  });

  it("起動し直した要素は、値が解決する前に移動しても onMount を呼ばない", async () => {
    const tag = nextTag();
    const seen: number[] = [];
    let runs = 0;
    defineElement(
      tag,
      (_props: object, ctx: Ctx) => {
        const run = ++runs;
        const value = memo(() => (run === 1 ? "sync" : new Promise<string>(() => {})));
        ctx.onMount(() => seen.push(run));
        return jsx("p", { children: () => value() });
      },
      { props: [] },
    );
    const el = await connect(document.createElement(tag));
    expect(seen).toEqual([1]);
    el.remove();
    await tick();
    await connect(el);
    const other = document.createElement("div");
    document.body.append(other);
    other.append(el);
    expect(seen).toEqual([1]);
  });

  it("同じタスクの中で接続、取り外し、接続をした最上位の要素は、1 回だけ起動する", async () => {
    const tag = nextTag();
    let runs = 0;
    defineElement(
      tag,
      () => {
        runs++;
        return jsx("p", { children: "x" });
      },
      { props: [] },
    );
    const el = document.createElement(tag);
    document.body.append(el);
    el.remove();
    document.body.append(el);
    await tick();
    flush();
    expect(runs).toBe(1);
    expect(shadow(el)).toBe("<p>x</p>");
    el.remove();
    document.body.append(document.createElement("div"));
    await tick();
    expect(runs).toBe(1);
  });

  it("破棄した最上位の要素を再び接続すると、props の値を維持したまま 1 回だけ描画し直す", async () => {
    const tag = nextTag();
    defineElement(tag, (props: CounterProps) => jsx("p", { children: () => props.label }), {
      props: ["label"],
    });
    const el = (await connect(document.createElement(tag))) as HTMLElement & CounterProps;
    el.label = "kept";
    flush();
    el.remove();
    await tick();
    await connect(el);
    expect(shadow(el)).toBe("<p>kept</p>");
  });

  it("破棄した描画の範囲で登録した onMount の関数は、起動し直しても呼ばない", async () => {
    const tag = nextTag();
    const seen: number[] = [];
    const resolvers: ((value: string) => void)[] = [];
    let runs = 0;
    defineElement(
      tag,
      (_props: object, ctx: Ctx) => {
        const run = ++runs;
        const value = memo(() => new Promise<string>((r) => resolvers.push(r)));
        ctx.onMount(() => seen.push(run));
        return jsx("p", { children: () => value() });
      },
      { props: [] },
    );
    const el = await connect(document.createElement(tag));
    el.remove();
    await tick();
    resolvers[0]!("first");
    await connect(el);
    expect(seen).toEqual([]);
    resolvers[1]!("second");
    await tick();
    flush();
    expect(seen).toEqual([2]);
  });
});

/** `invalidate` を呼んだ回数を数える、`import.meta.hot` の代わりを作成する。 */
function createHot() {
  const hot = { invalidated: 0, invalidate: () => void hot.invalidated++ };
  return hot;
}

describe("開発中の再登録", () => {
  it("同じタグをもう一度登録すると、表示中のインスタンスを、props の値を引き継いで新しい関数で描画する", async () => {
    const tag = nextTag();
    const options = { props: ["label"] };
    defineElement(
      tag,
      (props: CounterProps) => jsx("p", { children: () => `old:${props.label}` }),
      options,
    );
    const host = Object.assign(document.createElement(tag), { label: "a" });
    await connect(host);
    expect(shadow(host)).toBe("<p>old:a</p>");
    const hot = createHot();
    defineElement(
      tag,
      (props: CounterProps) => jsx("p", { children: () => `new:${props.label}` }),
      options,
      hot,
    );
    flush();
    expect(shadow(host)).toBe("<p>new:a</p>");
    Object.assign(host, { label: "b" });
    flush();
    expect(shadow(host)).toBe("<p>new:b</p>");
    const later = await connect(document.createElement(tag));
    expect(shadow(later)).toBe("<p>new:undefined</p>");
    expect(hot.invalidated).toBe(0);
  });

  it("登録の設定が変わると、関数を置換せずに invalidate を呼ぶ", async () => {
    const tag = nextTag();
    defineElement(tag, () => jsx("p", { children: "old" }), {
      props: ["label"],
    });
    const host = await connect(document.createElement(tag));
    const hot = createHot();
    defineElement(tag, () => jsx("p", { children: "new" }), { props: ["count"] }, hot);
    flush();
    expect(hot.invalidated).toBe(1);
    expect(shadow(host)).toBe("<p>old</p>");
  });

  it("import.meta.hot を渡さずに同じタグをもう一度登録すると、エラーにする", () => {
    const tag = nextTag();
    defineElement(tag, empty, { props: [] });
    expect(() => defineElement(tag, empty, { props: [] })).toThrow(tag);
  });
});

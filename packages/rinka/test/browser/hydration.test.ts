import { afterEach, describe, expect, it, vi } from "vitest";

import { Errored as ClientErrored, Loading as ClientLoading } from "../../src/client/control.ts";
import { defineElement as defineClient } from "../../src/client/element.ts";
import { jsx as clientJsx } from "../../src/client/jsx-runtime.ts";
import { bootstrapSource } from "../../src/server/bootstrap.ts";
import { Errored as ServerErrored, Loading as ServerLoading } from "../../src/server/control.ts";
import { defineElement as defineServer } from "../../src/server/element.ts";
import { jsx as serverJsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream } from "../../src/server/response.ts";
import { BOUNDARY_ATTRIBUTE, BOUNDARY_END, REGION_FALLBACK } from "../../src/shared/attributes.ts";
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
 * サーバーだけが出力する、Shadow DOM の直下の `<style>` と `<link>`、フォームの部品の hidden input、`<textarea>` の中身、後送りの境界の目印、`<Errored>` のフォールバックの目印は除く。
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
      if (!node.data.startsWith(BOUNDARY_END) && node.data !== REGION_FALLBACK) {
        out.push(`<!--${node.data}-->`);
      }
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

/**
 * `fixture` の要素をサーバーで描画して配置し、ホストと、クライアントで同じタグを登録して起動する関数を返す。
 * 子要素のタグも、サーバーとクライアントで同じ名前にする。
 */
async function served(fixture: Fixture): Promise<{ host: HTMLElement; boot: () => Promise<void> }> {
  const tag = `test-hy-b-${++count}`;
  const definer =
    (side: Side) => (name: string, fn: () => unknown, props?: Record<string, string>) =>
      side.define(`${tag}-${name}`, fn, props);
  await serve(serverSide.h(serverSide.define(tag, fixture(serverSide, definer(serverSide))), {}));
  const host = document.querySelector<HTMLElement>(tag)!;
  return {
    host,
    boot: async () => {
      clientSide.define(tag, fixture(clientSide, definer(clientSide)));
      await tick();
      await tick();
    },
  };
}

describe("SSR の DOM の引き取り", () => {
  it("起動の前と後で、静的なノードと、領域のテキストが同じオブジェクトで、リスナーと更新が動作する", async () => {
    const [clicks, setClicks] = signal(0);
    const { host, boot } = await served(
      ({ h }) =>
        () =>
          h("button", { onClick: () => setClicks(clicks() + 1), children: ["n=", () => clicks()] }),
    );
    const button = host.shadowRoot!.querySelector("button")!;
    const text = button.childNodes[2];
    await boot();
    expect(host.shadowRoot!.querySelector("button")).toBe(button);
    expect(button.childNodes[2]).toBe(text);
    button.click();
    await tick();
    expect(button.textContent).toBe("n=1");
    expect(text?.isConnected).toBe(false);
  });

  it("入れ子の子要素のホストと、その Shadow DOM のノードを引き取る", async () => {
    const { host, boot } = await served(
      ({ h }, define) =>
        () =>
          h("div", {
            children: h(
              define("child", () => h("i", { children: "c" })),
              {},
            ),
          }),
    );
    const child = host.shadowRoot!.querySelector("div")!.firstElementChild!;
    const inner = child.shadowRoot!.querySelector("i");
    await boot();
    expect(host.shadowRoot!.querySelector("div")!.firstElementChild).toBe(child);
    expect(child.shadowRoot!.querySelector("i")).toBe(inner);
  });

  it("起動の前に入力した値と、フォーカスが残る", async () => {
    const { host, boot } = await served(
      ({ h }) =>
        () =>
          h("input", { name: "q" }),
    );
    const input = host.shadowRoot!.querySelector("input")!;
    input.value = "typed";
    input.focus();
    await boot();
    expect(host.shadowRoot!.querySelector("input")).toBe(input);
    expect(input.value).toBe("typed");
    expect(host.shadowRoot!.activeElement).toBe(input);
  });

  it("名前付きスロットのテキストを引き取る", async () => {
    const { host, boot } = await served(({ h }, define) => {
      const card = define("card", () => h("section", { children: h("slot", { name: "head" }) }), {
        head: "slot",
      });
      return () => h(card, { head: ["見出し", h("b", { children: "b" })] });
    });
    const card = host.shadowRoot!.firstElementChild!;
    const span = card.querySelector("span");
    await boot();
    expect(host.shadowRoot!.firstElementChild).toBe(card);
    expect(card.querySelector("span")).toBe(span);
  });

  it("後送りの境界を差し替えた後に起動すると、差し替えた中身を引き取る", async () => {
    const { host, boot } = await served(({ h, Loading }) => () => {
      const value = memo(() => Promise.resolve("late"), { site: "hy:b1" });
      return h(Loading, { fallback: "wait", children: () => h("p", { children: () => value() }) });
    });
    const p = host.shadowRoot!.querySelector("p");
    expect(p?.textContent).toBe("late");
    await boot();
    expect(host.shadowRoot!.querySelector("p")).toBe(p);
  });

  it.each([
    [
      "クライアントでだけ異なる要素を返す描画",
      (side: Side) => side.h(side.prefix === serverSide.prefix ? "p" : "div", { children: "x" }),
    ],
    [
      "<table> の直下に <tr> を置く描画",
      (side: Side) =>
        side.h("table", { children: side.h("tr", { children: side.h("td", { children: "x" }) }) }),
    ],
  ])("%sは、例外を投げずに作り直し、開発時に警告する", async (_, view) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, boot } = await served((side) => () => view(side));
    const before = host.shadowRoot!.firstElementChild;
    await boot();
    expect(host.shadowRoot!.firstElementChild).not.toBe(before);
    expect(host.shadowRoot!.textContent).toBe("x");
    expect(warn.mock.calls.some(([message]) => String(message).includes("引き取れません"))).toBe(
      true,
    );
    warn.mockRestore();
  });

  it("引き継いだ値の無い非同期の memo を読む領域は、解決するまで SSR の表示を残し、要素の関数を 1 回だけ実行する", async () => {
    const { promise, resolve } = Promise.withResolvers<string>();
    let runs = 0;
    const { host, boot } = await served(({ h, prefix }) => () => {
      if (prefix === clientSide.prefix) runs++;
      const value = memo(() => (prefix === serverSide.prefix ? Promise.resolve("ssr") : promise));
      return [h("input", {}), h("p", { children: () => value() })];
    });
    const input = host.shadowRoot!.querySelector("input");
    const p = host.shadowRoot!.querySelector("p");
    await boot();
    expect(host.shadowRoot!.querySelector("p")).toBe(p);
    expect(p?.textContent).toBe("ssr");
    resolve("client");
    await tick();
    expect(host.shadowRoot!.querySelector("p")).toBe(p);
    expect(host.shadowRoot!.querySelector("input")).toBe(input);
    expect(p?.textContent).toBe("client");
    expect(runs).toBe(1);
  });

  it("保留中の値を属性にだけ使用する要素は、SSR の表示を残し、値が解決したら属性を設定する", async () => {
    const { promise, resolve } = Promise.withResolvers<string>();
    let runs = 0;
    const { host, boot } = await served(({ h, prefix }) => () => {
      if (prefix === clientSide.prefix) runs++;
      const value = memo(() => (prefix === serverSide.prefix ? Promise.resolve("ssr") : promise));
      return h("p", { title: () => value(), children: "body" });
    });
    const p = host.shadowRoot!.querySelector("p");
    await boot();
    expect(host.shadowRoot!.querySelector("p")).toBe(p);
    expect(p?.textContent).toBe("body");
    resolve("client");
    await tick();
    expect(host.shadowRoot!.querySelector("p")).toBe(p);
    expect(p?.getAttribute("title")).toBe("client");
    expect(runs).toBe(1);
  });
  it("両側で投げた <Errored> は、フォールバックを描画し、リスナーが動作する", async () => {
    let clicked = 0;
    const { host, boot } = await served(
      ({ h, Errored }) =>
        () =>
          h(Errored, {
            fallback: () => h("button", { onClick: () => clicked++, children: "retry" }),
            children: () => {
              throw new Error("boom");
            },
          }),
    );
    await boot();
    host.shadowRoot!.querySelector("button")!.click();
    expect(clicked).toBe(1);
  });

  it("中の領域が両側で投げた <Errored> は、作り直さずにフォールバックを表示する", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let clicked = 0;
    let runs = 0;
    const { host, boot } = await served(({ h, Errored, prefix }) => () => {
      if (prefix === clientSide.prefix) runs++;
      return h(Errored, {
        fallback: () => h("button", { onClick: () => clicked++, children: "retry" }),
        children: () =>
          h("p", {
            children: () => {
              throw new Error("boom");
            },
          }),
      });
    });
    await boot();
    host.shadowRoot!.querySelector("button")!.click();
    expect(clicked).toBe(1);
    expect(runs).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("両側で投げた <Errored> の中身のリスナーは、フォールバックに残らない", async () => {
    let stale = 0;
    let good = 0;
    const { host, boot } = await served(
      ({ h, Errored }) =>
        () =>
          h(Errored, {
            fallback: () => [
              h("button", { onClick: () => good++, children: "retry" }),
              h("p", { children: () => "x" }),
            ],
            children: () => [
              h("button", { onClick: () => stale++, children: "retry" }),
              h("p", {
                children: () => {
                  throw new Error("boom");
                },
              }),
            ],
          }),
    );
    await boot();
    host.shadowRoot!.querySelector("button")!.click();
    expect([stale, good]).toEqual([0, 1]);
  });

  it("クライアントでだけ投げた <Errored> は、領域をフォールバックで置換する", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, boot } = await served(
      ({ h, Errored, prefix }) =>
        () =>
          h(Errored, {
            fallback: () => h("b", { children: "failed" }),
            children: () => {
              if (prefix === clientSide.prefix) throw new Error("boom");
              return h("i", { children: "ok" });
            },
          }),
    );
    await boot();
    expect(host.shadowRoot!.textContent).toBe("failed");
    warn.mockRestore();
  });

  it("描画の先頭の <style> は、サーバーのスタイルとして扱わずに引き取る", async () => {
    const { host, boot } = await served(({ h }) => () => [
      h("style", { children: "p{color:red}" }),
      h("p", { children: "x" }),
    ]);
    const p = host.shadowRoot!.querySelector("p");
    await boot();
    expect(host.shadowRoot!.querySelector("p")).toBe(p);
    expect(host.shadowRoot!.querySelector("style")?.textContent).toBe("p{color:red}");
  });

  it("内容だけが異なるテキストは、作り直さずに内容を更新する", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, boot } = await served(
      ({ h, prefix }) =>
        () =>
          h("p", { children: () => (prefix === serverSide.prefix ? "server" : "client") }),
    );
    const p = host.shadowRoot!.querySelector("p")!;
    const text = p.childNodes[1];
    await boot();
    expect(host.shadowRoot!.querySelector("p")).toBe(p);
    expect(p.childNodes[1]).toBe(text);
    expect(p.textContent).toBe("client");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("<textarea> は要素を引き取り、中身のテキストを作り直す", async () => {
    const { host, boot } = await served(
      ({ h }) =>
        () =>
          h("textarea", { children: "init" }),
    );
    const textarea = host.shadowRoot!.querySelector("textarea")!;
    await boot();
    expect(host.shadowRoot!.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("init");
  });

  it("フォールバックで置換した領域は、兄弟の保留中の値が解決した後も残る", async () => {
    const { promise, resolve } = Promise.withResolvers<string>();
    const { host, boot } = await served(({ h, Errored, prefix }) => () => {
      const value = memo(() => (prefix === serverSide.prefix ? Promise.resolve("ssr") : promise));
      return [
        h(Errored, {
          fallback: () => h("b", { children: "f" }),
          children: () => {
            throw new Error("boom");
          },
        }),
        h("p", { children: () => value() }),
      ];
    });
    await boot();
    resolve("client");
    await tick();
    expect(host.shadowRoot!.textContent).toBe("fclient");
  });

  it("保留中の <Loading> の SSR の表示は、兄弟の保留中の値が解決した後も残る", async () => {
    const outer = Promise.withResolvers<string>();
    const { host, boot } = await served(({ h, Loading, prefix }) => () => {
      const inner = memo(() =>
        prefix === serverSide.prefix ? Promise.resolve("s1") : new Promise<string>(() => {}),
      );
      const value = memo(() =>
        prefix === serverSide.prefix ? Promise.resolve("s2") : outer.promise,
      );
      return [
        h(Loading, { fallback: "wait", children: () => h("i", { children: inner() }) }),
        h("p", { children: () => value() }),
      ];
    });
    await boot();
    outer.resolve("c2");
    await tick();
    expect(host.shadowRoot!.textContent).toBe("s1c2");
  });

  it("起動の前に変更したフォームの部品の値は、props の最初の値で上書きしない", async () => {
    const [text, setText] = signal("server");
    const [on] = signal(false);
    const [choice] = signal("a");
    const { host, boot } = await served(({ h }) => () => [
      h("input", { value: () => text() }),
      h("input", { type: "checkbox", checked: () => on() }),
      h("select", {
        value: () => choice(),
        children: [
          h("option", { value: "a", children: "A" }),
          h("option", { value: "b", children: "B" }),
        ],
      }),
      h("input", { value: "kept" }),
    ]);
    const [input, checkbox, untouched] = host.shadowRoot!.querySelectorAll("input");
    const select = host.shadowRoot!.querySelector("select")!;
    input!.value = "typed";
    checkbox!.checked = true;
    select.value = "b";
    await boot();
    expect(input!.value).toBe("typed");
    expect(checkbox!.checked).toBe(true);
    expect(select.value).toBe("b");
    expect(untouched!.value).toBe("kept");
    setText("next");
    await tick();
    expect(input!.value).toBe("next");
  });

  it("変更していないフォームの部品には、クライアントの最初の値を設定する", async () => {
    const { host, boot } = await served(({ h, prefix }) => () => {
      const server = prefix === serverSide.prefix;
      return [
        h("input", { value: () => (server ? "s" : "c") }),
        h("input", { type: "number", value: () => (server ? "1x" : "5") }),
        h("input", { type: "checkbox", checked: () => !server }),
        h("input", { type: "range", value: () => (server ? "150" : "160"), max: 200 }),
        h("textarea", { value: () => (server ? "s" : "c") }),
        h("textarea", { value: () => (server ? "\ns" : "\nc") }),
        h("select", {
          value: () => (server ? "zzz" : "b"),
          children: [
            h("optgroup", { disabled: true, children: h("option", { value: "x", children: "X" }) }),
            h("option", { value: "a", children: "A" }),
            h("option", { value: "b", children: "B" }),
          ],
        }),
        h("select", {
          children: [
            h("option", { value: "p", children: "P" }),
            h("option", { value: "q", selected: () => !server, children: "Q" }),
          ],
        }),
      ];
    });
    await boot();
    const [text, number, checkbox, range] = host.shadowRoot!.querySelectorAll("input");
    const [select, other] = host.shadowRoot!.querySelectorAll("select");
    expect(text!.value).toBe("c");
    expect(number!.value).toBe("5");
    expect(checkbox!.checked).toBe(true);
    expect(range!.value).toBe("160");
    const [textarea, multiline] = host.shadowRoot!.querySelectorAll("textarea");
    expect(textarea!.value).toBe("c");
    expect(multiline!.value).toBe("\nc");
    expect(select!.value).toBe("b");
    expect(other!.value).toBe("q");
  });

  it("起動の前に変更した <textarea> と、<option> の選択は残る", async () => {
    const { host, boot } = await served(({ h }) => () => [
      h("textarea", { value: "init" }),
      h("select", {
        children: [
          h("option", { value: "p", selected: true, children: "P" }),
          h("option", { value: "q", children: "Q" }),
        ],
      }),
    ]);
    const textarea = host.shadowRoot!.querySelector("textarea")!;
    const select = host.shadowRoot!.querySelector("select")!;
    textarea.value = "typed";
    select.value = "q";
    await boot();
    expect(textarea.value).toBe("typed");
    expect(select.value).toBe("q");
  });
});

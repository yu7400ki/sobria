import { createRoot, flush } from "@solidjs/signals";
import { describe, expect, it } from "vitest";

import { Errored, Loading } from "../../src/client/control.ts";
import { HTML_NS, SVG_NS } from "../../src/client/dom.ts";
import { Fragment, jsx, jsxs } from "../../src/client/jsx-runtime.ts";
import { signal } from "../../src/shared/signals.ts";
import { toNode } from "./nodes.ts";

/** `render` を root の中で実行し、結果をノードにしたものと root を破棄する関数を返す。 */
function mount(render: () => unknown): { node: Node; dispose: () => void } {
  return createRoot((dispose) => ({ node: toNode<Node>(render()), dispose }));
}

/** ノードを `div` に挿入して、コメントを除いた HTML の文字列を返す。 */
function html(node: unknown): string {
  const div = document.createElement("div");
  div.append((node as Node).cloneNode(true));
  return div.innerHTML.replaceAll(/<!--[[\]]-->/g, "");
}

describe("ネイティブのタグ", () => {
  it("属性を属性の出力の規則で設定し、key を data-ok にする", () => {
    const { node } = mount(() =>
      jsx(
        "div",
        {
          id: "a",
          class: { on: true, off: false },
          hidden: true,
          title: null,
          "aria-hidden": false,
        },
        "k1",
      ),
    );
    expect(html(node)).toBe(
      '<div id="a" class="on" hidden="" aria-hidden="false" data-ok="k1"></div>',
    );
  });

  it("関数の値の属性は、値が変化するたびに設定し直す", () => {
    const [title, setTitle] = signal<string | null>("x");
    const { node } = mount(() => jsx("p", { title: () => title() }));
    const el = node as unknown as HTMLElement;
    expect(el.getAttribute("title")).toBe("x");
    setTitle("y");
    flush();
    expect(el.getAttribute("title")).toBe("y");
    setTitle(null);
    flush();
    expect(el.hasAttribute("title")).toBe(false);
  });

  it("on と大文字で始まる名前の関数は、小文字のイベント名のリスナーにする", () => {
    const log: string[] = [];
    const { node } = mount(() =>
      jsx("button", {
        onClick: (e: Event) => log.push(e.type),
        onDblClick: (e: Event) => log.push(e.type),
      }),
    );
    const el = node as unknown as HTMLButtonElement;
    el.click();
    el.dispatchEvent(new MouseEvent("dblclick"));
    expect(log).toEqual(["click", "dblclick"]);
    expect(el.hasAttribute("onClick")).toBe(false);
  });

  it("value と checked はプロパティとして設定し、利用者が入力した後も値の変化を反映する", () => {
    const [text, setText] = signal<string | undefined>("a");
    const { node } = mount(() =>
      jsxs("form", {
        children: [
          jsx("input", { value: () => text() }),
          jsx("input", { type: "checkbox", checked: true }),
          jsx("textarea", { value: "t" }),
          jsx("input", { value: "150", type: "range", max: "200" }),
        ],
      }),
    );
    const form = node as unknown as HTMLFormElement;
    const [input, checkbox, range] = form.querySelectorAll("input");
    expect(input!.value).toBe("a");
    expect(input!.hasAttribute("value")).toBe(false);
    expect(checkbox!.checked).toBe(true);
    expect(checkbox!.hasAttribute("checked")).toBe(false);
    expect(form.querySelector("textarea")!.value).toBe("t");
    expect(range!.value).toBe("150");
    input!.value = "typed";
    setText("b");
    flush();
    expect(input!.value).toBe("b");
    setText(undefined);
    flush();
    expect(input!.value).toBe("");
  });

  it("select の value は option を挿入した後にプロパティとして設定する", () => {
    const { node } = mount(() =>
      jsxs("select", {
        value: "2",
        children: [jsx("option", { value: "1" }), jsx("option", { value: "2" })],
      }),
    );
    const select = node as unknown as HTMLSelectElement;
    expect(select.value).toBe("2");
    expect(select.hasAttribute("value")).toBe(false);
  });

  it("option の selected はプロパティとして設定し、利用者が選択を変えた後も値の変化を反映する", () => {
    const [selected, setSelected] = signal(true);
    const { node } = mount(() =>
      jsxs("select", {
        children: [
          jsx("option", { value: "1" }),
          jsx("option", { value: "2", selected: () => selected() }),
        ],
      }),
    );
    const select = node as unknown as HTMLSelectElement;
    const second = select.options[1]!;
    expect(second.selected).toBe(true);
    expect(second.hasAttribute("selected")).toBe(false);
    second.selected = false;
    setSelected(false);
    flush();
    setSelected(true);
    flush();
    expect(select.value).toBe("2");
  });

  it("ref はノードを作成した時点で呼び、ref が返した関数は描画の範囲を破棄するときに呼ぶ", () => {
    const log: string[] = [];
    const [el, setEl] = signal<Element>();
    const { dispose } = mount(() =>
      jsxs("div", {
        children: [
          jsx("span", {
            ref: (node: Element) => {
              log.push(`ref ${node.tagName} ${node.isConnected}`);
              return () => log.push("cleanup");
            },
          }),
          jsx("b", { ref: setEl }),
        ],
      }),
    );
    flush();
    expect(log).toEqual(["ref SPAN false"]);
    expect(el()?.tagName).toBe("B");
    dispose();
    expect(log).toEqual(["ref SPAN false", "cleanup"]);
  });
});

describe("子", () => {
  it("文字列、数値、bigint はテキストにし、null、undefined、真偽値は出力せず、配列は展開する", () => {
    const { node } = mount(() =>
      jsx("p", { children: ["a", 1, 2n, null, undefined, false, true, [jsx("b", {}), ["c"]]] }),
    );
    expect(html(node)).toBe("<p>a12<b></b>c</p>");
  });

  it("関数の子は、前後の兄弟の間の位置で置換する", () => {
    const [count, setCount] = signal(1);
    const { node } = mount(() =>
      jsx("p", {
        children: [
          "[",
          () => (count() > 1 ? [jsx("b", { children: count() }), "!"] : count()),
          "]",
        ],
      }),
    );
    expect(html(node)).toBe("<p>[1]</p>");
    setCount(2);
    flush();
    expect(html(node)).toBe("<p>[<b>2</b>!]</p>");
    setCount(1);
    flush();
    expect(html(node)).toBe("<p>[1]</p>");
  });

  it("配列の要素ごとの関数は独立した領域になり、ほかの要素のノードを再作成しない", () => {
    const [a, setA] = signal("a");
    const [b] = signal("b");
    const { node } = mount(() =>
      jsx("p", {
        children: [() => jsx("i", { children: a() }), () => jsx("u", { children: b() })],
      }),
    );
    const p = node as unknown as HTMLElement;
    const u = p.querySelector("u");
    setA("A");
    flush();
    expect(html(p)).toBe("<p><i>A</i><u>b</u></p>");
    expect(p.querySelector("u")).toBe(u);
  });

  it("関数の子が返した配列と Fragment の中の関数も独立した領域になる", () => {
    let runs = 0;
    const [a, setA] = signal("a");
    function Static() {
      runs++;
      return jsx("b", {});
    }
    const { node } = mount(() =>
      jsx("p", {
        children: () => jsxs(Fragment, { children: [jsx(Static, {}), () => a()] }),
      }),
    );
    const p = node as unknown as HTMLElement;
    const b = p.querySelector("b");
    setA("A");
    flush();
    expect(html(p)).toBe("<p><b></b>A</p>");
    expect(p.querySelector("b")).toBe(b);
    expect(runs).toBe(1);
  });

  it("関数を返す関数の子は、内側の関数も値の変化に追従する", () => {
    const [a, setA] = signal("a");
    const { node } = mount(() => jsx("p", { children: () => () => a() }));
    setA("A");
    flush();
    expect(html(node)).toBe("<p>A</p>");
  });
});

describe("名前空間", () => {
  it("<svg> とその子孫は SVG の名前空間で作成し、<foreignObject> の子は HTML の名前空間で作成する", () => {
    const { node } = mount(() =>
      jsx("div", {
        children: jsxs("svg", {
          children: [
            jsx("a", { children: jsx("path", {}) }),
            jsx("foreignObject", { children: jsx("a", { children: jsx("p", {}) }) }),
          ],
        }),
      }),
    );
    const div = node as HTMLElement;
    expect(div.namespaceURI).toBe(HTML_NS);
    expect(div.querySelector("svg")?.namespaceURI).toBe(SVG_NS);
    expect(div.querySelector("svg > a")?.namespaceURI).toBe(SVG_NS);
    expect(div.querySelector("path")?.namespaceURI).toBe(SVG_NS);
    expect(div.querySelector("foreignObject")?.namespaceURI).toBe(SVG_NS);
    expect(div.querySelector("foreignObject > a")?.namespaceURI).toBe(HTML_NS);
    expect(div.querySelector("p")?.namespaceURI).toBe(HTML_NS);
  });

  it("<svg> の中の領域が後から作成するタグも、SVG の名前空間で作成する", () => {
    const [shown, setShown] = signal(false);
    const { node } = mount(() =>
      jsx("svg", {
        children: [
          () => (shown() ? jsx("path", { id: "a" }) : null),
          () => [() => (shown() ? jsx("circle", {}) : null)],
        ],
      }),
    );
    setShown(true);
    flush();
    const root = node as SVGSVGElement;
    expect(root.querySelector("path")?.namespaceURI).toBe(SVG_NS);
    expect(root.querySelector("circle")?.namespaceURI).toBe(SVG_NS);
  });

  it("<svg> の中の <Loading> と <Errored> の中身も、SVG の名前空間で作成する", () => {
    const { node } = mount(() =>
      jsxs("svg", {
        children: [
          jsx(Loading, { children: jsx("path", {}) }),
          jsx(Errored, { fallback: null, children: jsx("circle", {}) }),
        ],
      }),
    );
    const root = node as SVGSVGElement;
    expect(root.querySelector("path")?.namespaceURI).toBe(SVG_NS);
    expect(root.querySelector("circle")?.namespaceURI).toBe(SVG_NS);
  });

  it("領域の中の <svg> は、SVG の名前空間で作成する", () => {
    const [shown, setShown] = signal(false);
    const { node } = mount(() =>
      jsx("div", { children: () => (shown() ? jsx("svg", { children: jsx("path", {}) }) : null) }),
    );
    setShown(true);
    flush();
    expect((node as HTMLElement).querySelector("path")?.namespaceURI).toBe(SVG_NS);
  });
});

describe("コンポーネント", () => {
  it("関数は props を受け取って 1 回だけ実行し、本体で読み取った値を追跡しない", () => {
    let runs = 0;
    const [name, setName] = signal("a");
    function Hello() {
      runs++;
      return jsxs("span", { children: ["hello ", name()] });
    }
    const { node } = mount(() => jsx("p", { children: () => jsx(Hello, {}) }));
    expect(html(node)).toBe("<p><span>hello a</span></p>");
    setName("b");
    flush();
    expect(html(node)).toBe("<p><span>hello a</span></p>");
    expect(runs).toBe(1);
  });

  it("Fragment は子をそのまま返す", () => {
    const { node } = mount(() =>
      jsx("p", { children: jsxs(Fragment, { children: ["a", jsx("b", {})] }) }),
    );
    expect(html(node)).toBe("<p>a<b></b></p>");
  });
});

describe("ノードの作成", () => {
  it("ノードと ref は、JSX を挿入した時点で作成して呼ぶ", () => {
    const refs: string[] = [];
    createRoot(() => {
      const node = jsx("p", { ref: (el: Element) => refs.push(el.localName) });
      expect(refs).toEqual([]);
      toNode(node);
      expect(refs).toEqual(["p"]);
    });
  });

  it("同じ JSX を 2 回挿入すると、最初に作成したノードを移動する", () => {
    createRoot(() => {
      const node = jsx("p", {});
      const first = toNode(node);
      expect(toNode(node)).toBe(first);
    });
  });

  it("ノードの作成が投げた値は、挿入するたびに投げ直し、作成を繰り返さない", () => {
    let calls = 0;
    const error = new Error("ref");
    createRoot(() => {
      const node = jsx("p", {
        ref: () => {
          calls++;
          throw error;
        },
      });
      expect(() => toNode(node)).toThrow(error);
      expect(() => toNode(node)).toThrow(error);
    });
    expect(calls).toBe(1);
  });
});

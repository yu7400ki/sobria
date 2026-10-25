import { afterEach, describe, expect, it } from "vitest";

import { bootstrap } from "../../src/server/bootstrap.ts";
import { Errored, Loading } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { notFound } from "../../src/server/errors.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream } from "../../src/server/response.ts";
import type { Receiver } from "../../src/shared/receiver.ts";

afterEach(() => {
  document.body.replaceChildren();
});

/** `html` の文書を iframe で解析し、読み込みが終わった文書を返す。 */
async function parse(html: string): Promise<Document> {
  const frame = document.createElement("iframe");
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  frame.srcdoc = html;
  document.body.append(frame);
  await loaded;
  const doc = frame.contentDocument;
  if (!doc) throw new Error("iframe の文書を取得できません");
  return doc;
}

/** `body` を、`head` の後に起動スクリプトを置いた文書として解析し、読み込みが終わった文書を返す。 */
const load = (body: string, head = ""): Promise<Document> =>
  parse(`<!doctype html><html><head>${head}${bootstrap}</head><body>${body}</body></html>`);

/** サーバーが描画した文書を解析し、読み込みが終わった文書を返す。 */
async function render(node: unknown): Promise<Document> {
  const decoder = new TextDecoder();
  let html = "";
  for await (const chunk of renderToStream(node)) html += decoder.decode(chunk);
  return parse(html);
}

/** ホストの ID が `id` の要素の Shadow DOM を返す。 */
function shadow(doc: Document, id: string): ShadowRoot {
  const root = doc.querySelector(`[data-oh="${id}"]`)?.shadowRoot;
  if (!root) throw new Error(`${id} の Shadow DOM がありません`);
  return root;
}

/** 文書の `$rinka` を返す。 */
function rinka(doc: Document) {
  const view = doc.defaultView as unknown as { $rinka: Receiver };
  return view.$rinka;
}

/** `$rinka.v` を返す。 */
const values = (doc: Document) => rinka(doc).v;

describe("差し替えのスクリプト", () => {
  it("目印の間のフォールバックを、後送りの境界の中身に差し替え、目印とテンプレートとスクリプトを除く", async () => {
    const doc = await load(
      '<main><template data-ob="b1"></template>wait<!--/ob:b1--></main>' +
        '<template data-os="b1"><b>done</b></template><script>$rinka.r({"b":"b1","bp":[],"p":[]})</script>',
    );
    expect(doc.querySelector("main")?.innerHTML).toBe("<b>done</b>");
    expect(doc.body.querySelectorAll("template, script").length).toBe(0);
  });

  it("後送りの中身の DSD を、Shadow DOM として取り付ける", async () => {
    const doc = await load(
      '<template data-ob="b1"></template>wait<!--/ob:b1-->' +
        '<template data-os="b1"><x-a data-oh="h2"><template shadowrootmode="open"><p>s</p></template></x-a></template>' +
        '<script>$rinka.r({"b":"b1","bp":[],"p":[]})</script>',
    );
    expect(shadow(doc, "h2").innerHTML).toBe("<p>s</p>");
  });

  it("要素の中の境界は、ホストの ID の列をたどって差し替える", async () => {
    const doc = await load(
      '<x-card data-oh="h1" data-om="@b"><template shadowrootmode="open"><template data-ob="b2"></template>wait<!--/ob:b2--></template></x-card>' +
        '<template data-os="b2"><b>v</b></template><script>$rinka.r({"b":"b2","bp":["h1"],"p":[]})</script>',
    );
    expect(shadow(doc, "h1").innerHTML).toBe("<b>v</b>");
  });

  it("境界に属する差し替えは、それぞれの目印の位置に差し込む", async () => {
    const doc = await load(
      '<x-container data-oh="h1" data-om="@b"><template shadowrootmode="open"><template data-ob="b2"></template>wait<!--/ob:b2--></template>' +
        '<x-child data-oh="h3"><template shadowrootmode="open"><i><template data-ob="p4"></template><!--/ob:p4--></i></template></x-child></x-container>' +
        '<template data-os="b2"><slot></slot></template><template data-op="p4">v</template>' +
        '<script>$rinka.r({"b":"b2","bp":["h1"],"p":[["p4",["h3"]]]})</script>',
    );
    expect(shadow(doc, "h1").innerHTML).toBe("<slot></slot>");
    expect(shadow(doc, "h3").innerHTML).toBe("<i>v</i>");
  });

  it("終了の目印が無い差し替えは、目印の後の内容を残して、テンプレートだけを除く", async () => {
    const doc = await load(
      '<div><template data-ob="b1"></template>wait<span>keep</span></div>' +
        '<template data-os="b1"><b>x</b></template><script>$rinka.r({"b":"b1","bp":[],"p":[]})</script>',
    );
    expect(doc.querySelector("div")?.innerHTML).toBe(
      '<template data-ob="b1"></template>wait<span>keep</span>',
    );
    expect(doc.body.querySelectorAll("template[data-os]").length).toBe(0);
  });

  it("既にある $rinka の値を残す", async () => {
    const doc = await load(
      '<template data-ob="b1"></template><!--/ob:b1-->' +
        '<template data-os="b1"></template><script>$rinka.r({"b":"b1","bp":[],"p":[]})</script>',
      "<script>window.$rinka={v:{h1:{a:1}}}</script>",
    );
    expect(values(doc).h1).toEqual({ a: 1 });
  });

  it("Shadow DOM として取り付けられていない DSD を、差し替えの前に取り付ける", async () => {
    const doc = await load('<template data-ob="b1"></template>wait<!--/ob:b1-->');
    const holder = doc.createElement("div");
    holder.innerHTML =
      '<template data-os="b1"><x-a data-oh="h2"><template shadowrootmode="open"><p>s</p></template></x-a></template>';
    const template = holder.firstElementChild;
    if (!template) throw new Error("テンプレートがありません");
    doc.body.append(template);
    rinka(doc).r({ b: "b1", bp: [], p: [] });
    expect(shadow(doc, "h2").innerHTML).toBe("<p>s</p>");
  });
});

describe("フォームの部品の DSD", () => {
  it("差し替えの前に取り付ける DSD の shadowrootdelegatesfocus を、Shadow DOM の delegatesFocus にする", async () => {
    const doc = await load('<template data-ob="b1"></template>wait<!--/ob:b1-->');
    const holder = doc.createElement("div");
    holder.innerHTML =
      '<template data-os="b1"><x-f data-oh="h2"><template shadowrootmode="open" shadowrootdelegatesfocus><button></button></template></x-f></template>';
    doc.body.append(holder.firstElementChild!);
    rinka(doc).r({ b: "b1", bp: [], p: [] });
    expect(shadow(doc, "h2").delegatesFocus).toBe(true);
  });
});

/** 10ms 後に解決する Promise を返す。 */
const later = () => new Promise((resolve) => setTimeout(resolve, 10));

const Slow = async () => {
  await later();
  return jsx("b", { children: "late" });
};

const Missing = async () => {
  await later();
  throw notFound();
};

describe("サーバーの出力", () => {
  it("スロットの内容の差し替えを、ブラウザで適用する", async () => {
    const Container = defineElement(
      "x-swap-container",
      () => jsx(Loading, { fallback: "wait", children: jsx("slot", {}) }),
      { props: { children: "slot" } },
    );
    const doc = await render(jsx(Container, { children: jsx(Slow, {}) }));
    const host = doc.querySelector('[data-oh="h1"]');
    expect(host?.shadowRoot?.innerHTML).toBe("<slot></slot>");
    expect(host?.innerHTML).toBe("<b>late</b>");
    expect(values(doc).h1).toEqual({ "@b": 1 });
  });

  it("シェルの後の notFound() では、<head> にも noindex を追加する", async () => {
    const doc = await render(
      jsx(Loading, {
        fallback: "wait",
        children: jsx(Errored, { fallback: "無い", children: jsx(Missing, {}) }),
      }),
    );
    expect(doc.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex");
    expect(doc.body.textContent).toContain("無い");
  });

  it("シェルの後に Loading の中身が失敗すると、Loading を外側から囲む Errored の領域を、ブラウザでフォールバックに差し替える", async () => {
    const doc = await render(
      jsx("main", {
        children: jsx(Errored, {
          fallback: "失敗",
          children: ["前", jsx(Loading, { fallback: "wait", children: jsx(Missing, {}) })],
        }),
      }),
    );
    expect(doc.querySelector("main")?.innerHTML).toBe("失敗");
  });
});

/** 文書の `<head>` に追加する要素を、追加せずに `added` に記録する。 */
function capture(doc: Document): Element[] {
  const added: Element[] = [];
  doc.head.append = (...nodes) => {
    for (const node of nodes) if (node instanceof doc.defaultView!.Element) added.push(node);
  };
  return added;
}

describe("後送りの内容の CSS の待機", () => {
  it('差し替える内容の <link rel="stylesheet"> を、入れ子の template の中まで探して preload し、読み込みが完了するまで差し替えない', async () => {
    const doc = await load(
      '<main><template data-ob="b1"></template>wait<!--/ob:b1--></main>' +
        '<template data-os="b1"><x-card><template shadowrootmode="open"><link rel="stylesheet" href="/card.css"><p>card</p></template></x-card></template>',
    );
    const added = capture(doc);
    rinka(doc).r({ b: "b1", bp: [], p: [] });
    expect(doc.querySelector("main")!.textContent).toBe("wait");
    expect(added).toHaveLength(1);
    const preload = added[0] as HTMLLinkElement;
    expect([preload.rel, preload.getAttribute("as"), new URL(preload.href).pathname]).toEqual([
      "preload",
      "style",
      "/card.css",
    ]);
    preload.dispatchEvent(new Event("load"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(doc.querySelector("x-card")!.shadowRoot!.querySelector("p")!.textContent).toBe("card");
  });

  it("CSS を待っている差し替えより後の差し替えは、前の差し替えを適用してから適用する。読み込みに失敗しても差し替える", async () => {
    const doc = await load(
      '<main><template data-ob="b1"></template>wait1<!--/ob:b1--><template data-ob="b2"></template>wait2<!--/ob:b2--></main>' +
        '<template data-os="b1"><link rel="stylesheet" href="/a.css"><b>one</b></template>' +
        '<template data-os="b2"><b>two</b></template>',
    );
    const added = capture(doc);
    rinka(doc).r({ b: "b1", bp: [], p: [] });
    rinka(doc).r({ b: "b2", bp: [], p: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(doc.querySelector("main")!.textContent).toBe("wait1wait2");
    added[0]!.dispatchEvent(new Event("error"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(doc.querySelector("main")!.textContent).toBe("onetwo");
  });

  it("CSS の無い差し替えは、すぐに適用する", async () => {
    const doc = await load(
      '<main><template data-ob="b1"></template>wait<!--/ob:b1--></main><template data-os="b1"><b>done</b></template>',
    );
    rinka(doc).r({ b: "b1", bp: [], p: [] });
    expect(doc.querySelector("main")!.textContent).toBe("done");
  });
});

describe("後送りの内容の CSS の待機で失敗した差し替え", () => {
  it("CSS を待った差し替えの適用で例外が起きても、後の差し替えを適用する", async () => {
    const doc = await load(
      '<main><template data-ob="b1"></template>wait1<!--/ob:b1--><template data-ob="b2"></template>wait2<!--/ob:b2--></main>' +
        '<template data-os="b1"><link rel="stylesheet" href="/a.css"><a><template shadowrootmode="open">x</template></a></template>' +
        '<template data-os="b2"><b>two</b></template>',
    );
    const added = capture(doc);
    rinka(doc).r({ b: "b1", bp: [], p: [] });
    rinka(doc).r({ b: "b2", bp: [], p: [] });
    added[0]!.dispatchEvent(new Event("load"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(doc.querySelector("main")!.textContent).toContain("two");
  });
});

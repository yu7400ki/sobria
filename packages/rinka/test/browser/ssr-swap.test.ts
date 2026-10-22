import { afterEach, describe, expect, it } from "vitest";

import { bootstrap } from "../../src/server/bootstrap.ts";
import { Errored, Loading } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { notFound } from "../../src/server/errors.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream } from "../../src/server/render.ts";

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
  const view = doc.defaultView as unknown as {
    $rinka: {
      v: Record<string, Record<string, unknown>>;
      w: Record<string, string[]>;
      r: (spec: unknown) => void;
    };
  };
  return view.$rinka;
}

/** `$rinka.v` を返す。 */
const values = (doc: Document) => rinka(doc).v;

describe("差し替えのスクリプト", () => {
  it("目印の間のフォールバックを、後送りの境界の中身に差し替え、目印とテンプレートとスクリプトを除く", async () => {
    const doc = await load(
      '<main><template data-ob="b1"></template>wait<!--/ob:b1--></main>' +
        '<template data-os="b1"><b>done</b></template><script>$rinka.r({"b":"b1","bp":[],"p":[],"h":[]})</script>',
    );
    expect(doc.querySelector("main")?.innerHTML).toBe("<b>done</b>");
    expect(doc.body.querySelectorAll("template, script").length).toBe(0);
  });

  it("後送りの中身の DSD を、Shadow DOM として取り付ける", async () => {
    const doc = await load(
      '<template data-ob="b1"></template>wait<!--/ob:b1-->' +
        '<template data-os="b1"><x-a data-oh="h2"><template shadowrootmode="open"><p>s</p></template></x-a></template>' +
        '<script>$rinka.r({"b":"b1","bp":[],"p":[],"h":[]})</script>',
    );
    expect(shadow(doc, "h2").innerHTML).toBe("<p>s</p>");
  });

  it("要素の中の境界は、ホストの ID の列をたどって差し替え、ホストに境界の完了を知らせる", async () => {
    const doc = await load(
      '<x-card data-oh="h1" data-om="@b2"><template shadowrootmode="open"><template data-ob="b2"></template>wait<!--/ob:b2--></template></x-card>' +
        '<template data-os="b2"><b>v</b></template><script>$rinka.r({"b":"b2","bp":["h1"],"p":[],"h":["h1"]})</script>',
    );
    expect(shadow(doc, "h1").innerHTML).toBe("<b>v</b>");
    expect(values(doc).h1).toEqual({ "@b2": 1 });
  });

  it("境界に属する差し替えは、それぞれの目印の位置に差し込む", async () => {
    const doc = await load(
      '<x-container data-oh="h1" data-om="@b2"><template shadowrootmode="open"><template data-ob="b2"></template>wait<!--/ob:b2--></template>' +
        '<x-child data-oh="h3" data-om="@b2"><template shadowrootmode="open"><i><template data-ob="p4"></template><!--/ob:p4--></i></template></x-child></x-container>' +
        '<template data-os="b2"><slot></slot></template><template data-op="p4">v</template>' +
        '<script>$rinka.r({"b":"b2","bp":["h1"],"p":[["p4",["h3"]]],"h":["h1","h3"]})</script>',
    );
    expect(shadow(doc, "h1").innerHTML).toBe("<slot></slot>");
    expect(shadow(doc, "h3").innerHTML).toBe("<i>v</i>");
    expect(values(doc).h3).toEqual({ "@b2": 1 });
  });

  it("終了の目印が無い差し替えは、目印の後の内容を残して、テンプレートだけを除く", async () => {
    const doc = await load(
      '<div><template data-ob="b1"></template>wait<span>keep</span></div>' +
        '<template data-os="b1"><b>x</b></template><script>$rinka.r({"b":"b1","bp":[],"p":[],"h":[]})</script>',
    );
    expect(doc.querySelector("div")?.innerHTML).toBe(
      '<template data-ob="b1"></template>wait<span>keep</span>',
    );
    expect(doc.body.querySelectorAll("template[data-os]").length).toBe(0);
  });

  it("既にある $rinka の値を残し、spec の w をホストが待つキーに加える", async () => {
    const doc = await load(
      '<template data-ob="b1"></template><!--/ob:b1-->' +
        '<template data-os="b1"></template><script>$rinka.r({"b":"b1","bp":[],"p":[],"h":[],"w":[["h1","@b3"]]})</script>',
      "<script>window.$rinka={v:{h1:{a:1}}}</script>",
    );
    expect(values(doc).h1).toEqual({ a: 1 });
    expect(rinka(doc).w).toEqual({ h1: ["@b3"] });
  });

  it("Shadow DOM として取り付けられていない DSD を、差し替えの前に取り付ける", async () => {
    const doc = await load('<template data-ob="b1"></template>wait<!--/ob:b1-->');
    const holder = doc.createElement("div");
    holder.innerHTML =
      '<template data-os="b1"><x-a data-oh="h2"><template shadowrootmode="open"><p>s</p></template></x-a></template>';
    const template = holder.firstElementChild;
    if (!template) throw new Error("テンプレートがありません");
    doc.body.append(template);
    rinka(doc).r({ b: "b1", bp: [], p: [], h: [] });
    expect(shadow(doc, "h2").innerHTML).toBe("<p>s</p>");
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
      { props: ["children"] },
    );
    const doc = await render(jsx(Container, { children: jsx(Slow, {}) }));
    const host = doc.querySelector('[data-oh="h1"]');
    expect(host?.shadowRoot?.innerHTML).toBe("<slot></slot>");
    expect(host?.innerHTML).toBe("<b>late</b>");
    expect(values(doc).h1).toEqual({ "@b2": 1 });
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
});

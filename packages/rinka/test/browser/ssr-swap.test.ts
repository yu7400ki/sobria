import { afterEach, describe, expect, it } from "vitest";

import { bootstrap } from "../../src/server/bootstrap.ts";

afterEach(() => {
  document.body.replaceChildren();
});

/** `body` を、起動スクリプトを含む文書として iframe で解析し、読み込みが終わった文書を返す。 */
async function load(body: string): Promise<Document> {
  const frame = document.createElement("iframe");
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  frame.srcdoc = `<!doctype html><html><head>${bootstrap}</head><body>${body}</body></html>`;
  document.body.append(frame);
  await loaded;
  const doc = frame.contentDocument;
  if (!doc) throw new Error("iframe の文書を取得できません");
  return doc;
}

/** ホストの ID が `id` の要素の Shadow DOM を返す。 */
function shadow(doc: Document, id: string): ShadowRoot {
  const root = doc.querySelector(`[data-oh="${id}"]`)?.shadowRoot;
  if (!root) throw new Error(`${id} の Shadow DOM がありません`);
  return root;
}

/** `$rinka.v` を返す。 */
function values(doc: Document): Record<string, Record<string, unknown>> {
  const view = doc.defaultView as unknown as {
    $rinka: { v: Record<string, Record<string, unknown>> };
  };
  return view.$rinka.v;
}

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
});

import { describe, expect, it } from "vitest";

import { checkOrder } from "./stream-order.ts";

const head = '<!doctype html><html><head><meta charset="utf-8"></head><body>';
const host =
  '<x-a data-oh="h1" data-om="k @b"><template shadowrootmode="open"><template data-ob="b2"></template>f<!--/ob:b2--></template></x-a>';
const swap =
  '<template data-os="b2">s</template><script>$rinka.r({"b":"b2","bp":["h1"],"p":[]})</script>';
const value = '<script>$rinka.d("h1",{"k":"v"})</script>';
const done = '<script>$rinka.d("h1",{"@b":1})</script>';

describe("出力の順序の検査", () => {
  it("前提に合う出力では、エラーを投げない", () => {
    expect(() => checkOrder([head + host, value, swap, done, "</body></html>"])).not.toThrow();
  });

  it("data-om のキーの値を送らないか、2 回送れば、エラーを投げる", () => {
    expect(() => checkOrder([head + host, swap, done])).toThrow("0 回");
    expect(() => checkOrder([head + host, value, value, swap, done])).toThrow("2 回");
  });

  it("チャンクが無いか、最初のチャンクが文書の先頭でなければ、エラーを投げる", () => {
    expect(() => checkOrder([])).toThrow("最初のチャンク");
    expect(() => checkOrder([value, head + host])).toThrow("最初のチャンク");
  });

  it("$rinka.r が境界の目印より前にあれば、エラーを投げる", () => {
    expect(() => checkOrder([head + swap + host])).toThrow("目印");
  });

  it("$rinka.d がホストの開始タグより前にあれば、エラーを投げる", () => {
    expect(() => checkOrder([head + value + host])).toThrow("開始タグ");
  });

  it("$rinka.d のキーが data-om に無ければ、エラーを投げる", () => {
    const unknown = '<script>$rinka.d("h1",{"other":1})</script>';
    expect(() => checkOrder([head + host, unknown])).toThrow("data-om");
  });

  it("@b が、そのホストを含む $rinka.r より前にあれば、エラーを投げる", () => {
    expect(() => checkOrder([head + host, done, swap])).toThrow("@b");
  });

  it("@b が、そのホストを差し替えの列に含む $rinka.r より前にあっても、エラーを投げる", () => {
    const patch =
      '<template data-os="b2">s</template><script>$rinka.r({"b":"b2","bp":[],"p":[["p3",["h1"]]]})</script>';
    expect(() => checkOrder([head + host, done, patch])).toThrow("@b");
  });
});

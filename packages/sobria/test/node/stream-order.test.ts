import { describe, expect, it } from "vitest";

import { checkOrder } from "./stream-order.ts";

const head = '<!doctype html><html><head><meta charset="utf-8"></head><body>';
const host =
  '<x-a data-oh="h1" data-om="k @b"><template shadowrootmode="open"><template data-ob="b2"></template>f<!--/ob:b2--></template></x-a>';
const swap =
  '<template data-os="b2">s</template><script>$sobria.r({"b":"b2","bp":["h1"],"p":[]})</script>';
const value = '<script>$sobria.d("h1",{"k":"v"})</script>';
/** 開始タグの後に作成した子要素のホスト `child` の ID を、h1 に `@c:キー` で送るスクリプトを返す。 */
const late = (child: string) => `<script>$sobria.d("h1",{"@c:s#0":"${child}"})</script>`;
const done = '<script>$sobria.d("h1",{"@b":1})</script>';

describe("出力の順序の検査", () => {
  it("前提に合う出力では、エラーを投げない", () => {
    expect(() => checkOrder([head + host, value, swap, done, "</body></html>"])).not.toThrow();
  });

  it("data-om のキーの値を送らないか、2 回送れば、エラーを投げる", () => {
    expect(() => checkOrder([head + host, swap, done])).toThrow("送りませんでした");
    expect(() => checkOrder([head + host, value, value, swap, done])).toThrow("2 回");
  });

  it("data-om のキーが重複していれば、エラーを投げる", () => {
    const twice = host.replace('data-om="k @b"', 'data-om="k k @b"');
    expect(() => checkOrder([head + twice, value, swap, done])).toThrow("重複");
  });

  it("data-om に無い @c:キーは、値が出力したホストの ID で、@b より前に送るときだけ受け入れる", () => {
    const leaf = '<template data-os="b2"><x-c data-oh="h3"></x-c></template>';
    const reveal = '<script>$sobria.r({"b":"b2","bp":["h1"],"p":[]})</script>';
    expect(() => checkOrder([head + host, value, leaf + late("h3") + reveal, done])).not.toThrow();
    expect(() => checkOrder([head + host, value, leaf + late("h9") + reveal, done])).toThrow(
      "data-om",
    );
    expect(() => checkOrder([head + host, value, leaf + reveal, done, late("h3")])).toThrow(
      "@b より前",
    );
  });

  it("チャンクが無いか、最初のチャンクが文書の先頭でなければ、エラーを投げる", () => {
    expect(() => checkOrder([])).toThrow("最初のチャンク");
    expect(() => checkOrder([value, head + host])).toThrow("最初のチャンク");
  });

  it("$sobria.r が境界の目印より前にあれば、エラーを投げる", () => {
    expect(() => checkOrder([head + swap + host])).toThrow("目印");
  });

  it("$sobria.d がホストの開始タグより前にあれば、エラーを投げる", () => {
    expect(() => checkOrder([head + value + host])).toThrow("開始タグ");
  });

  it("$sobria.d のキーが data-om に無ければ、エラーを投げる", () => {
    const unknown = '<script>$sobria.d("h1",{"other":1})</script>';
    expect(() => checkOrder([head + host, unknown])).toThrow("data-om");
  });

  it("@b が、そのホストを含む $sobria.r より前にあれば、エラーを投げる", () => {
    expect(() => checkOrder([head + host, done, swap])).toThrow("@b");
  });

  it("@b が、そのホストを差し替えの列に含む $sobria.r より前にあっても、エラーを投げる", () => {
    const patch =
      '<template data-os="b2">s</template><script>$sobria.r({"b":"b2","bp":[],"p":[["p3",["h1"]]]})</script>';
    expect(() => checkOrder([head + host, done, patch])).toThrow("@b");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { morph } from "../../src/client/morph.ts";

afterEach(() => {
  document.body.replaceChildren();
});

/** `html` を子に持つ要素を `document.body` に置いて返す。 */
function container(html: string): HTMLElement {
  const element = document.createElement("div");
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

const noHost = () => {};

/** 接続された回数を数えるカスタム要素である。 */
class Probe extends HTMLElement {
  connected = 0;
  connectedCallback(): void {
    this.connected += 1;
  }
}
customElements.define("x-morph-probe", Probe);

describe("morph", () => {
  it("同じ位置の同じタグの要素とテキストは使用し続け、属性と子を新しい HTML に合わせる", () => {
    const root = container('<p class="a" title="t">old<b>x</b></p>text');
    const p = root.querySelector("p");
    const text = root.lastChild;
    morph(root, '<p class="b" id="i">new<b>y</b></p>changed', noHost);
    expect(root.innerHTML).toBe('<p class="b" id="i">new<b>y</b></p>changed');
    expect(root.querySelector("p")).toBe(p);
    expect(root.lastChild).toBe(text);
  });

  it("タグが異なる要素は置き換え、余った要素を取り除き、足りない要素を加える", () => {
    const root = container("<p>a</p><span>b</span><i>c</i>");
    const p = root.querySelector("p");
    const span = root.querySelector("span");
    morph(root, "<div>a</div><span>b</span>", noHost);
    expect(root.innerHTML).toBe("<div>a</div><span>b</span>");
    expect(root.contains(p)).toBe(false);
    expect(root.querySelector("span")).toBe(span);
    morph(root, "<div>a</div><span>b</span><em>c</em>", noHost);
    expect(root.innerHTML).toBe("<div>a</div><span>b</span><em>c</em>");
  });

  it("data-ok のキーが同じ要素どうしを対応付けて、並び替える", () => {
    const root = container('<li data-ok="1">1</li><li data-ok="2">2</li><li data-ok="3">3</li>');
    const [one, two, three] = root.querySelectorAll("li");
    morph(root, '<li data-ok="3">3</li><li data-ok="1">1!</li><li data-ok="4">4</li>', noHost);
    expect(root.innerHTML).toBe(
      '<li data-ok="3">3</li><li data-ok="1">1!</li><li data-ok="4">4</li>',
    );
    const items = root.querySelectorAll("li");
    expect(items[0]).toBe(three);
    expect(items[1]).toBe(one);
    expect([...items].includes(two as HTMLLIElement)).toBe(false);
  });

  it("キーのある要素はキーだけで対応付け、キーの無い要素は位置で対応付ける", () => {
    const root = container('<li data-ok="a">a</li><p>p</p><li>x</li>');
    const [keyed, unkeyed] = root.querySelectorAll("li");
    const p = root.querySelector("p");
    morph(root, '<p>p</p><li data-ok="a">a</li><li data-ok="n">x</li>', noHost);
    const items = root.querySelectorAll("li");
    expect(root.querySelector("p")).toBe(p);
    expect(items[0]).toBe(keyed);
    expect(items[1]).not.toBe(unkeyed);
    expect(root.innerHTML).toBe('<p>p</p><li data-ok="a">a</li><li data-ok="n">x</li>');
  });

  it("名前空間のある属性を名前空間とともに設定し、名前にコロンを含む HTML の属性も設定する", () => {
    const root = container('<svg><use></use></svg><div x-on:click="a"></div>');
    morph(
      root,
      '<svg><use xlink:href="#a"></use></svg><div x-on:click="b" xml:lang="ja"></div>',
      noHost,
    );
    expect(root.querySelector("div")?.outerHTML).toBe('<div x-on:click="b" xml:lang="ja"></div>');
    expect(root.querySelector("use")?.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe(
      "#a",
    );
  });

  it("要素のホストは属性を変更せず、Light DOM の子の差分を反映し、新しいホストの ID とともに渡す", () => {
    const root = container('<x-host data-oh="h1" class="own" label="a"><b>old</b></x-host>');
    const host = root.querySelector("x-host");
    const onHost = vi.fn();
    morph(root, '<x-host data-oh="r1-h1" label="b"><b>new</b></x-host>', onHost);
    expect(root.querySelector("x-host")).toBe(host);
    expect(host?.getAttribute("class")).toBe("own");
    expect(host?.getAttribute("label")).toBe("a");
    expect(host?.getAttribute("data-oh")).toBe("h1");
    expect(host?.innerHTML).toBe("<b>new</b>");
    expect(onHost).toHaveBeenCalledWith(host, "r1-h1");
  });

  it("新しく現れたホストは、新しい HTML の要素をそのまま加える", () => {
    const root = container("<p>a</p>");
    const onHost = vi.fn();
    morph(root, '<p>a</p><x-host data-oh="r1-h2" label="b"></x-host>', onHost);
    expect(root.innerHTML).toBe('<p>a</p><x-host data-oh="r1-h2" label="b"></x-host>');
    expect(onHost).not.toHaveBeenCalled();
  });

  it("ページにある <script> と <template> は変更せず、新しい HTML の <script> と <template> は加えない", () => {
    const root = container("<p>a</p><script>1</script><template>t</template><p>b</p>");
    const script = root.querySelector("script");
    const template = root.querySelector("template");
    morph(
      root,
      "<p>a!</p><script>2</script><template>u</template><p>b!</p><section><script>3</script><template>v</template></section>",
      noHost,
    );
    expect(root.querySelector("script")).toBe(script);
    expect(root.querySelector("template")).toBe(template);
    expect(root.querySelectorAll("script")).toHaveLength(1);
    expect(root.querySelectorAll("template")).toHaveLength(1);
    expect(root.textContent).toBe("a!1b!");
  });

  it("使用し続けるカスタム要素は接続し直さず、新しく加えたカスタム要素は接続した時点で起動する", () => {
    const root = container('<x-morph-probe data-oh="h1"></x-morph-probe>');
    const probe = root.querySelector("x-morph-probe");
    morph(
      root,
      '<x-morph-probe data-oh="r1-h1"></x-morph-probe><x-morph-probe data-oh="r1-h2"></x-morph-probe>',
      noHost,
    );
    const [kept, added] = root.querySelectorAll("x-morph-probe");
    expect(kept).toBe(probe);
    expect(kept instanceof Probe && kept.connected).toBe(1);
    expect(added instanceof Probe && added.connected).toBe(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { Errored, Loading } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { notFound, redirect } from "../../src/server/errors.ts";
import { registerServerFn } from "../../src/server/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream, renderToString } from "../../src/server/response.ts";
import { defineServerFn } from "../../src/server/server-fn.ts";
import type { Ctx } from "../../src/shared/element.ts";
import { read } from "./stream-order.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** `form.disabled()` をボタンの disabled に反映するフォームの部品である。 */
const Field = defineElement(
  "x-native-field",
  (_props: object, { form }: Ctx) => {
    form.value(() => "v");
    return jsx("button", { disabled: () => form.disabled() });
  },
  { props: {}, form: true },
);

/** Light DOM の子をスロットに配置する要素である。 */
const Wrap = defineElement("x-native-wrap", () => jsx("slot", {}), { props: {} });

/** `<select value="b">` の中に、選択の判定のすべての場合の `<option>` を置いた JSX を返す。 */
const select = () =>
  jsx("select", {
    value: "b",
    children: [
      jsx("optgroup", {
        children: [
          jsx("option", { value: "a", children: "A" }),
          jsx("option", { value: "b", children: "B" }),
        ],
      }),
      jsx("option", { children: "b" }),
      jsx("option", { value: "b", selected: false, children: "C" }),
    ],
  });

describe("ネイティブのタグの出力の全体", () => {
  it("fieldset と legend", async () => {
    expect(
      await renderToString(
        jsx("fieldset", {
          disabled: true,
          children: [
            jsx("legend", { children: jsx(Field, { name: "a" }) }),
            jsx("legend", { children: jsx(Field, { name: "b" }) }),
            jsx(Wrap, { children: jsx(Field, { name: "c" }) }),
          ],
        }),
      ),
    ).toMatchInlineSnapshot(
      `"<fieldset disabled><legend><x-native-field data-oh="h1" name="a"><template shadowrootmode="open" shadowrootdelegatesfocus><button></button></template><input type="hidden" name="a" value="v" data-rinka-form></x-native-field></legend><legend><x-native-field data-oh="h2" name="b"><template shadowrootmode="open" shadowrootdelegatesfocus><button disabled></button></template><input type="hidden" name="b" value="v" data-rinka-form disabled></x-native-field></legend><x-native-wrap data-oh="h3"><template shadowrootmode="open"><slot></slot></template><x-native-field data-oh="h4" name="c"><template shadowrootmode="open" shadowrootdelegatesfocus><button disabled></button></template><input type="hidden" name="c" value="v" data-rinka-form disabled></x-native-field></x-native-wrap></fieldset>"`,
    );
  });

  it("select と optgroup と option", async () => {
    expect(await renderToString(select())).toMatchInlineSnapshot(
      `"<select><optgroup><option value="a">A</option><option value="b" selected>B</option></optgroup><option selected>b</option><option value="b">C</option></select>"`,
    );
  });

  it("要素の Light DOM の中の select と option", async () => {
    expect(
      await renderToString(
        jsx("select", {
          value: "b",
          children: jsx(Wrap, { children: [jsx("option", { value: "b" }), select()] }),
        }),
      ),
    ).toMatchInlineSnapshot(
      `"<select><x-native-wrap data-oh="h1"><template shadowrootmode="open"><slot></slot></template><option value="b"></option><select><optgroup><option value="a">A</option><option value="b" selected>B</option></optgroup><option selected>b</option><option value="b">C</option></select></x-native-wrap></select>"`,
    );
  });

  it("textarea と title、その中の Errored", async () => {
    expect(
      await renderToString([
        jsx("textarea", { value: "v", children: "子" }),
        jsx("textarea", { children: jsx(Errored, { fallback: "f", children: "子" }) }),
        jsx("title", { children: jsx(Errored, { fallback: "f", children: "題" }) }),
      ]),
    ).toMatchInlineSnapshot(`
      "<textarea>
      v</textarea><textarea>子</textarea><title>題</title>"
    `);
  });

  it("label と form", async () => {
    const fn = registerServerFn(
      "src/native-tags.ts#fn",
      defineServerFn(() => null),
    );
    expect(
      await renderToString([
        jsx("label", { for: "f", children: "名前" }),
        jsx(Field, { id: "f", name: "n" }),
        jsx("form", { action: fn, children: jsx("input", { value: "v", checked: true }) }),
      ]),
    ).toMatchInlineSnapshot(
      `"<label for="f" id="rinka-l1">名前</label><x-native-field data-oh="h1" id="f" name="n" aria-labelledby="rinka-l1"><template shadowrootmode="open" shadowrootdelegatesfocus><button></button></template><input type="hidden" name="n" value="v" data-rinka-form></x-native-field><form action="/_rinka/fn/src%2Fnative-tags.ts%23fn" method="post" enctype="multipart/form-data"><input value="v" checked></form>"`,
    );
  });
});

/**
 * シェルを送った後に `error` を投げたときの、ストリームの `<main>` から後を返す。
 * `inside` が `true` なら Errored を Loading の内側に置き、`false` なら外側に置く。
 */
async function caught(error: unknown, inside = false): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const Fail = async () => {
    await promise;
    throw error;
  };
  const reading = read(
    renderToStream(
      jsx("main", {
        children: inside
          ? jsx(Loading, {
              fallback: "wait",
              children: jsx(Errored, { fallback: "caught", children: jsx(Fail, {}) }),
            })
          : jsx(Errored, {
              fallback: "caught",
              children: jsx(Loading, { fallback: "wait", children: jsx(Fail, {}) }),
            }),
      }),
    ),
  );
  await tick();
  resolve();
  const html = (await reading).join("");
  return html.slice(html.indexOf("<main>"));
}

describe("シェルを送った後に Errored が受け止めるストリームの全体", () => {
  it("同じ入力から同じストリームを出力する", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await caught(new Error("e"))).toBe(await caught(new Error("e")));
  });

  it("notFound()", async () => {
    expect(await caught(notFound())).toMatchInlineSnapshot(
      `"<main><template data-ob="e1"></template><template data-ob="b1"></template>wait<!--/ob:b1--><!--/ob:e1--></main><meta name="robots" content="noindex"><script>document.head.append(document.currentScript.previousSibling.cloneNode())</script><template data-os="e1">caught</template><script>$rinka.r({"b":"e1","bp":[],"p":[]})</script></body></html>"`,
    );
  });

  it("redirect()", async () => {
    expect(await caught(redirect("/next"))).toMatchInlineSnapshot(
      `"<main><template data-ob="e1"></template><template data-ob="b1"></template>wait<!--/ob:b1--><!--/ob:e1--></main><script>location.replace("/next")</script><meta http-equiv="refresh" content="0;url=/next"></body></html>"`,
    );
  });

  it("そのほかのエラー", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await caught(new Error("e"))).toMatchInlineSnapshot(
      `"<main><template data-ob="e1"></template><template data-ob="b1"></template>wait<!--/ob:b1--><!--/ob:e1--></main><template data-os="e1">caught</template><script>$rinka.r({"b":"e1","bp":[],"p":[]})</script></body></html>"`,
    );
  });

  it("Loading の内側の Errored が受け止める notFound()", async () => {
    expect(await caught(notFound(), true)).toMatchInlineSnapshot(
      `"<main><template data-ob="b1"></template>wait<!--/ob:b1--></main><meta name="robots" content="noindex"><script>document.head.append(document.currentScript.previousSibling.cloneNode())</script><template data-os="b1">caught</template><script>$rinka.r({"b":"b1","bp":[],"p":[]})</script></body></html>"`,
    );
  });

  it("Loading の内側の Errored の中の redirect()", async () => {
    expect(await caught(redirect("/next"), true)).toMatchInlineSnapshot(
      `"<main><template data-ob="b1"></template>wait<!--/ob:b1--></main><script>location.replace("/next")</script><meta http-equiv="refresh" content="0;url=/next"></body></html>"`,
    );
  });

  it("Loading の内側の Errored が受け止めるそのほかのエラー", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await caught(new Error("e"), true)).toMatchInlineSnapshot(
      `"<main><template data-ob="b1"></template>wait<!--/ob:b1--></main><template data-os="b1">caught</template><script>$rinka.r({"b":"b1","bp":[],"p":[]})</script></body></html>"`,
    );
  });
});

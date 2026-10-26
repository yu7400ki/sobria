import { afterEach, describe, expect, it, vi } from "vitest";

import { Errored, Loading } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream, renderToString } from "../../src/server/response.ts";
import type { Ctx } from "../../src/shared/element.ts";
import { memo } from "../../src/shared/signals.ts";
import { read } from "./stream-order.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** `value` を送信する値にし、`form.disabled()` をボタンの disabled に反映するフォームの部品を返す。 */
const field = (tag: string, value: () => unknown) =>
  defineElement(
    tag,
    (_props: object, { form }: Ctx) => {
      form.value(value as () => string);
      return jsx("button", { disabled: () => form.disabled() });
    },
    { props: {}, form: true },
  );

/** `value` に解決する非同期の memo を返す。 */
const later = <T>(value: T) => memo(async () => value);

/** disabled が失敗する非同期の値の `<fieldset>` を返す。 */
function FailingFieldset() {
  const bad = memo(async (): Promise<boolean> => {
    throw new Error("失敗");
  });
  return jsx("fieldset", { disabled: () => bad(), children: "x" });
}

/** `for="f"` の `<label>` を返す。 */
const label = (props: Record<string, unknown>) =>
  jsx("label", { for: "f", ...props, children: "評価" });

describe("SSR の ARIA 属性", () => {
  const Rating = defineElement(
    "x-rating",
    (_props: object, { internals }: Ctx) => {
      internals.role = "radiogroup";
      internals.ariaValueNow = "3";
      internals.ariaLabel = null;
      return null;
    },
    { props: {} },
  );

  it("internals に設定した role と aria* を、ホストの属性として出力し、名前を data-rinka-aria に列挙する", async () => {
    expect(await renderToString(jsx(Rating, {}))).toBe(
      '<x-rating data-oh="h1" role="radiogroup" aria-valuenow="3" data-rinka-aria="role aria-valuenow"><template shadowrootmode="open"><!--[--><!--]--></template></x-rating>',
    );
  });

  it("ページの側で値が undefined の属性は、internals の値を出力する", async () => {
    const Named = defineElement(
      "x-named",
      (_props: object, { internals }: Ctx) => {
        internals.ariaLabel = "内側";
        return null;
      },
      { props: {} },
    );
    expect(await renderToString(jsx(Named, { "aria-label": undefined }))).toContain(
      'aria-label="内側" data-rinka-aria="aria-label"',
    );
  });

  it("ページの側で同じ名前の属性を記述していれば、ページの値を出力し、data-rinka-aria に列挙しない", async () => {
    expect(await renderToString(jsx(Rating, { role: "group" }))).toBe(
      '<x-rating data-oh="h1" role="group" aria-valuenow="3" data-rinka-aria="aria-valuenow"><template shadowrootmode="open"><!--[--><!--]--></template></x-rating>',
    );
  });
});

describe("フォームの部品の SSR", () => {
  it("DSD に shadowrootdelegatesfocus を出力し、name のあるホストの Light DOM の先頭に、form.value の文字列の hidden input を出力する", async () => {
    const Field = field("x-field-a", () => 'a"<');
    expect(await renderToString(jsx(Field, { name: "score", children: "子" }))).toBe(
      '<x-field-a data-oh="h1" name="score"><template shadowrootmode="open" shadowrootdelegatesfocus><!--[--><button></button><!--]--></template><input type="hidden" name="score" value="a&quot;&lt;" data-rinka-form>子</x-field-a>',
    );
  });

  it("name が無いときと、値が null か undefined のときは、hidden input を出力しない", async () => {
    expect(
      await renderToString(
        jsx(
          field("x-field-b", () => "a"),
          {},
        ),
      ),
    ).not.toContain("hidden");
    expect(
      await renderToString(
        jsx(
          field("x-field-c", () => null),
          { name: "n" },
        ),
      ),
    ).not.toContain("hidden");
    expect(
      await renderToString(
        jsx(
          field("x-field-d", () => undefined),
          { name: "n" },
        ),
      ),
    ).not.toContain("hidden");
  });

  it("値が文字列でないときは、hidden input を出力せずに、開発時に警告する", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await renderToString(
        jsx(
          field("x-field-e", () => 3),
          { name: "n" },
        ),
      ),
    ).not.toContain("hidden");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("<x-field-e>");
  });

  it("ホストの disabled と、Light DOM で外側にある <fieldset disabled> で、form.disabled() が true を返し、hidden input に disabled を付与する", async () => {
    const Field = field("x-field-f", () => "a");
    const own = await renderToString(jsx(Field, { name: "n", disabled: true }));
    expect(own).toContain("<button disabled></button>");
    expect(own).toContain('<input type="hidden" name="n" value="a" data-rinka-form disabled>');
    const inFieldset = await renderToString(
      jsx("fieldset", {
        disabled: true,
        children: jsx("div", { children: jsx(Field, { name: "n" }) }),
      }),
    );
    expect(inFieldset).toContain("<button disabled></button>");
    expect(inFieldset).toContain("data-rinka-form disabled>");
    const enabled = await renderToString(
      jsx("fieldset", { disabled: false, children: jsx(Field, { name: "n" }) }),
    );
    expect(enabled).toContain("<button></button>");
    expect(enabled).not.toContain("data-rinka-form disabled");
  });

  it("<fieldset disabled> は、要素のスロットの内容と、入れ子の <fieldset> の中の部品を無効にし、最初の <legend> の中の部品は無効にしない", async () => {
    const Field = field("x-field-h", () => "a");
    const Wrap = defineElement("x-wrap", () => jsx("slot", {}), { props: {} });
    const slotted = await renderToString(
      jsx("fieldset", {
        disabled: true,
        children: jsx(Wrap, { children: jsx(Field, { name: "n" }) }),
      }),
    );
    expect(slotted).toContain("data-rinka-form disabled>");
    const html = await renderToString(
      jsx("fieldset", {
        disabled: true,
        children: [
          jsx("legend", { children: jsx(Field, { name: "a" }) }),
          jsx("legend", { children: jsx(Field, { name: "b" }) }),
          jsx("fieldset", { children: jsx(Field, { name: "c" }) }),
        ],
      }),
    );
    expect(html).toContain('name="a" value="a" data-rinka-form>');
    expect(html).toContain('name="b" value="a" data-rinka-form disabled>');
    expect(html).toContain('name="c" value="a" data-rinka-form disabled>');
  });

  it("disabled、name、form.value の値が未解決なら、解決するまで待って出力する", async () => {
    const Late = defineElement(
      "x-field-late",
      (_props: object, { form }: Ctx) => {
        const value = later("遅い");
        form.value(() => value());
        return jsx("button", { disabled: () => form.disabled() });
      },
      { props: {}, form: true },
    );
    const Page = () => {
      const off = later(true);
      const name = later("n");
      return [
        jsx("fieldset", { disabled: () => off(), children: jsx(Late, { name: "a" }) }),
        jsx(Late, {
          get name() {
            return name();
          },
          get disabled() {
            return off();
          },
        }),
      ];
    };
    const html = await renderToString(jsx(Page, {}));
    expect(html).toContain(
      '<button disabled></button><!--]--></template><input type="hidden" name="a" value="遅い" data-rinka-form disabled>',
    );
    expect(html).toContain('<input type="hidden" name="n" value="遅い" data-rinka-form disabled>');
  });

  it("form.value に渡した関数は、要素の関数を実行した後に評価する", async () => {
    const Field = defineElement(
      "x-field-after",
      (_props: object, { form }: Ctx) => {
        let value = "前";
        form.value(() => value);
        value = "後";
        return null;
      },
      { props: {}, form: true },
    );
    expect(await renderToString(jsx(Field, { name: "n" }))).toContain('value="後"');
  });

  it("未解決の <fieldset> の disabled が失敗しても、中にフォームの部品が無ければ、処理されない失敗を残さない", async () => {
    expect(
      await renderToString(jsx(Errored, { fallback: "fb", children: jsx(FailingFieldset, {}) })),
    ).toBe("fb");
    await new Promise((done) => setTimeout(done, 10));
  });

  it("要素の Shadow DOM の中は、外側の <fieldset disabled> で無効にしない", async () => {
    const Field = field("x-field-g", () => "a");
    const Wrapper = defineElement("x-wrapper", () => jsx(Field, { name: "n" }), { props: {} });
    const html = await renderToString(
      jsx("fieldset", { disabled: true, children: jsx(Wrapper, {}) }),
    );
    expect(html).toContain("<button></button>");
  });

  it("フォームの部品でない要素で form.value か form.validity を呼ぶと、エラーを送出する", async () => {
    const calls = [
      (form: Ctx["form"]) => form.value(() => "a"),
      (form: Ctx["form"]) => form.validity(() => null),
    ];
    await Promise.all(
      calls.map((call, index) => {
        const Plain = defineElement(
          `x-plain-form-${index}`,
          (_props: object, { form }: Ctx) => {
            call(form);
            return null;
          },
          { props: {} },
        );
        return expect(renderToString(jsx(Plain, {}))).rejects.toThrow(
          "フォームの部品として登録されていない",
        );
      }),
    );
  });
});

describe("<label for> の補完", () => {
  const Field = field("x-labelled", () => "a");

  it("フォームの部品のホストの id を for に指定した <label> を、aria-labelledby で指す。id の無い <label> には rinka-l と連番の id を付与する", async () => {
    const before = await renderToString([label({}), jsx(Field, { id: "f" })]);
    expect(before).toContain('<label for="f" id="rinka-l1">');
    expect(before).toContain('<x-labelled data-oh="h1" id="f" aria-labelledby="rinka-l1">');
    const after = await renderToString([jsx(Field, { id: "f" }), label({ id: "own" })]);
    expect(after).toContain('<x-labelled data-oh="h1" id="f" aria-labelledby="own">');
  });

  it("同じ for の値を持つ <label> が複数あれば、最初に描画したものを指す", async () => {
    const html = await renderToString([
      label({ id: "a" }),
      label({ id: "b" }),
      jsx(Field, { id: "f" }),
    ]);
    expect(html).toContain('aria-labelledby="a"');
  });

  it("ホストに aria-label か aria-labelledby があるときと、該当する <label> が無いときは、aria-labelledby を付与しない", async () => {
    expect(
      await renderToString([label({}), jsx(Field, { id: "f", "aria-label": "名前" })]),
    ).not.toContain("aria-labelledby");
    expect(
      await renderToString([label({}), jsx(Field, { id: "f", "aria-labelledby": "x" })]),
    ).toContain('<x-labelled data-oh="h1" id="f" aria-labelledby="x">');
    expect(await renderToString(jsx(Field, { id: "f" }))).not.toContain("aria-labelledby");
  });

  it("後から書き出す後送りの部分にある <label> は指さない", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const Slow = async () => {
      await promise;
      return label({});
    };
    const stream = renderToStream(
      jsx("main", {
        children: [
          jsx(Field, { id: "f" }),
          jsx(Loading, { fallback: "wait", children: jsx(Slow, {}) }),
        ],
      }),
    );
    const reading = read(stream);
    await new Promise((done) => setTimeout(done, 0));
    resolve();
    const html = (await reading).join("");
    expect(html).toContain('<label for="f" id="rinka-l1">');
    expect(html).not.toContain("aria-labelledby");
  });

  it("文書の順で最初の <label> を指し、失敗した <Errored> の領域の <label> は指さない", async () => {
    const Async = async () => label({ id: "first" });
    expect(
      await renderToString([jsx(Async, {}), label({ id: "second" }), jsx(Field, { id: "f" })]),
    ).toContain('aria-labelledby="first"');
    const failed = await renderToString([
      jsx(Errored, { fallback: "fb", children: [label({ id: "lost" }), jsx(FailingFieldset, {})] }),
      label({ id: "kept" }),
      jsx(Field, { id: "f" }),
    ]);
    expect(failed).toContain('aria-labelledby="kept"');
  });

  it("<Loading> のフォールバックの中の <label> は指さない", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const Slow = async () => {
      await promise;
      return label({ id: "content" });
    };
    const Wrap = defineElement("x-wrap-loading", () => jsx("slot", {}), { props: {} });
    const loading = () =>
      jsx(Loading, {
        fallback: jsx("div", {
          children: [label({ id: "fallback" }), jsx(Wrap, { children: label({ id: "slotted" }) })],
        }),
        children: jsx(Slow, {}),
      });
    const Card = defineElement("x-card-loading", () => [jsx(Field, { id: "f" }), loading()], {
      props: {},
    });
    const stream = renderToStream(
      jsx("main", { children: [jsx(Field, { id: "f" }), loading(), jsx(Card, {})] }),
    );
    const reading = read(stream);
    await new Promise((done) => setTimeout(done, 0));
    resolve();
    const html = (await reading).join("");
    expect(html).toContain('<label for="f" id="fallback">');
    expect(html).not.toContain("aria-labelledby");
  });

  it("<Loading> のフォールバックの中にある要素の Shadow DOM では、同じ Shadow DOM の <label> を指す", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const Slow = async () => {
      await promise;
      return null;
    };
    const Card = defineElement("x-card-fallback", () => [label({}), jsx(Field, { id: "f" })], {
      props: {},
    });
    const stream = renderToStream(
      jsx("main", { children: jsx(Loading, { fallback: jsx(Card, {}), children: jsx(Slow, {}) }) }),
    );
    const reading = read(stream);
    await new Promise((done) => setTimeout(done, 0));
    resolve();
    expect((await reading).join("")).toContain('id="f" aria-labelledby="rinka-l1">');
  });

  it("<label> とホストが同じ tree scope にあるときだけ指す", async () => {
    const Card = defineElement("x-card-label", () => [label({}), jsx(Field, { id: "f" })], {
      props: {},
    });
    const html = await renderToString([label({ id: "outer" }), jsx(Card, {}), jsx(Card, {})]);
    expect(html).toContain('<x-labelled data-oh="h2" id="f" aria-labelledby="rinka-l1">');
    expect(html).toContain('<x-labelled data-oh="h4" id="f" aria-labelledby="rinka-l2">');
    expect(html).not.toContain('aria-labelledby="outer"');
  });

  it("数値の id の <label> は、その id を指す", async () => {
    expect(await renderToString([label({ id: 5 }), jsx(Field, { id: "f" })])).toContain(
      'aria-labelledby="5"',
    );
  });

  it("後送りの部分にあるホストは、先に書き出した単位と同じ単位の <label> を指し、該当が無ければ目印を残さない", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const Slow = async (props: { children: unknown }) => {
      await promise;
      return props.children;
    };
    const deferred = (children: unknown) =>
      jsx(Loading, { fallback: "wait", children: jsx(Slow, { children }) });
    const stream = renderToStream(
      jsx("main", {
        children: [
          label({ for: "a", id: "shell" }),
          deferred([
            jsx(Field, { id: "a" }),
            label({ for: "b", id: "same" }),
            jsx(Field, { id: "b" }),
            jsx(Field, { id: "c" }),
          ]),
        ],
      }),
    );
    const reading = read(stream);
    await new Promise((done) => setTimeout(done, 0));
    resolve();
    const html = (await reading).join("");
    expect(html).toContain('id="a" aria-labelledby="shell">');
    expect(html).toContain('id="b" aria-labelledby="same">');
    expect(html).toMatch(/id="c"><template/);
    expect(html).not.toContain("\u0000");
  });
});

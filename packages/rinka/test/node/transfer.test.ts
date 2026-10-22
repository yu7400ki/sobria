import { afterEach, describe, expect, it, vi } from "vitest";

import { Loading } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream, renderToString } from "../../src/server/render.ts";
import { memo } from "../../src/shared/signals.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** 値が無いことを表す、`$rinka.n` の代わりのオブジェクト。 */
const missing = { missing: true };

/** `node` を文書として描画し、HTML と、出力したスクリプトが `$rinka.d` に渡した値を返す。 */
async function render(node: unknown) {
  const decoder = new TextDecoder();
  let html = "";
  for await (const chunk of renderToStream(node)) html += decoder.decode(chunk);
  const sent: [string, Record<string, unknown>][] = [];
  const rinka = {
    n: missing,
    d: (id: string, values: Record<string, unknown>) => sent.push([id, values]),
    r: () => {},
  };
  for (const [, script] of html.matchAll(/<script>(.*?)<\/script>/gs)) {
    if (script === undefined || script.startsWith("(R=>")) continue;
    // oxlint-disable-next-line typescript/no-implied-eval
    new Function("$rinka", script)(rinka);
  }
  return { html, sent };
}

/** 呼び出し箇所 `site` の非同期の memo の値を表示する要素を登録する。 */
function defineAsync(tag: string, site: string, compute: () => Promise<unknown>) {
  return defineElement(
    tag,
    () => {
      const value = memo(compute, { site });
      return jsx("p", { children: () => String(value()) });
    },
    { props: [] },
  );
}

/** 明示的なキー `keys` の非同期の memo を作成する要素を登録する。 */
const defineKeyed = (tag: string, keys: string[]) =>
  defineElement(
    tag,
    () => {
      for (const key of keys) memo(() => Promise.resolve(1), { key });
      return null;
    },
    { props: [] },
  );
describe("memo の値", () => {
  it("キーのある非同期の memo の値を、data-om に列挙して $rinka.d で送る", async () => {
    const Card = defineAsync("x-tr1", "c.tsx:1:1", () => Promise.resolve(new Date(0)));
    const { html, sent } = await render(jsx(Card, {}));
    expect(html).toContain('<x-tr1 data-oh="h1" data-om="c.tsx:1:1#0">');
    expect(sent).toEqual([["h1", { "c.tsx:1:1#0": new Date(0) }]]);
  });

  it("同期の memo と、キーの無い memo の値は送らない", async () => {
    const Card = defineElement(
      "x-tr2",
      () => {
        const sync = memo(() => 1, { site: "c.tsx:2:1" });
        const unkeyed = memo(() => Promise.resolve(2));
        return jsx("p", { children: () => sync() + unkeyed() });
      },
      { props: [] },
    );
    const { html, sent } = await render(jsx(Card, {}));
    expect(html).toContain('<x-tr2 data-oh="h1"><template shadowrootmode="open"><p>3</p>');
    expect(sent).toEqual([]);
  });

  it("失敗した memo のキーには、値が無いことを送る", async () => {
    const Card = defineElement(
      "x-tr3",
      () => {
        const value = memo(() => Promise.reject(new Error("e")), { site: "c.tsx:3:1" });
        return jsx(Loading, { fallback: "f", children: jsx("p", { children: () => value() }) });
      },
      { props: [] },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { sent } = await render(jsx(Card, {}));
    expect(sent).toContainEqual(["h1", { "c.tsx:3:1#0": missing }]);
  });

  it("シリアライズできない値は、値が無いことを送って記録する", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    class User {
      readonly name = "u";
    }
    const Card = defineAsync("x-tr4", "c.tsx:4:1", () => Promise.resolve(new User()));
    const { sent } = await render(jsx(Card, {}));
    expect(sent).toEqual([["h1", { "c.tsx:4:1#0": missing }]]);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("明示的なキーに使用できない値を指定すると、エラーにする", async () => {
    await expect(renderToString(jsx(defineKeyed("x-tr5", ["a b"]), {}))).rejects.toThrow("キー");
    await expect(renderToString(jsx(defineKeyed("x-tr6", ["@x"]), {}))).rejects.toThrow("キー");
    await expect(renderToString(jsx(defineKeyed("x-tr7", [""]), {}))).rejects.toThrow("キー");
    await expect(renderToString(jsx(defineKeyed("x-tr8", ["k", "k"]), {}))).rejects.toThrow("キー");
  });
});

describe("props の値", () => {
  const Card = defineElement(
    "x-tr-card",
    (props: { data?: object; onPick?: () => void }) =>
      jsx("p", { children: () => typeof props.data }),
    { props: ["data", "onPick"], functionProps: ["onPick"] },
  );

  it("属性にできない props を、@p として $rinka.d で送る", async () => {
    const { html, sent } = await render(jsx(Card, { data: { a: [1] } }));
    expect(html).toContain('<x-tr-card data-oh="h1" data-om="@p">');
    expect(sent).toEqual([["h1", { "@p": { data: { a: [1] } } }]]);
  });

  it("要素の Shadow DOM の中の子要素には、属性にできない props を送らない", async () => {
    const Outer = defineElement(
      "x-tr-outer",
      () => jsx(Card, { data: { a: 1 }, onPick: () => {} }),
      { props: [] },
    );
    const { html, sent } = await render(jsx(Outer, {}));
    expect(html).toContain('<x-tr-card data-oh="h2"><template shadowrootmode="open"><p>object</p>');
    expect(sent).toEqual([]);
  });
});
